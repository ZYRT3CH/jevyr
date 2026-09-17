import {
  digestJson,
  type AssayPayload,
  type CandidatePayload,
  type CaseEvent,
  type EvidencePayload,
  type Feasibility,
  type JsonValue,
  type MemoryInfluencePayload,
  validateCaseEventShape,
} from "@jevyr/protocol";
import { EvidenceGraph, type EvidenceAuthority } from "./evidence.js";
import { verifyEventChain } from "./events.js";
import { assertIntentContract, obligationsFromIntentContract, type IntentContract } from "./intent.js";
import { compileVerdict, type AssayAssessment, type CandidateAssessment, type IntegrityIssue, type Obligation, type PolicyInput } from "./policy.js";
import { assertReflexComplete, evaluateReflex, type IntentBoundReflexPayload } from "./reflex.js";
import { originalSubjectPurpose, type OriginalSubjectContext } from "./original-subject.js";

/** Replay without the sealed contract is diagnosable but can never yield an applicable judgment. */
export const UNBOUND_INTENT_CONTRACT_DIGEST = digestJson({ protocol: "jevyr.intent-contract/unbound" });

/**
 * One verdict-bearing edge whose durable sandbox artifact, sealed oracle, and
 * surrounding Assay Frontier transcript were independently replayed.
 *
 * Event projection deliberately treats this as an allowlist rather than
 * trusting the public event's `sandbox_execution` label.
 */
export interface VerifiedEvidenceEdge {
  readonly eventDigest: string;
  readonly evidenceId: string;
  readonly contentDigest: string;
  readonly targetId: string;
  readonly kind: "supports" | "refutes";
}

export interface ReplayProjectionOptions {
  policyVersion?: string;
  intentContract?: IntentContract;
  readonly formalProofKernelDigest?: string;
  readonly verifiedEvidenceEdges?: readonly VerifiedEvidenceEdge[];
  readonly verifiedOriginalSubjectEdges?: readonly VerifiedEvidenceEdge[];
  readonly originalSubjectContext?: OriginalSubjectContext;
}

export interface EventProjection {
  graph: EvidenceGraph;
  input: PolicyInput;
  reflexReports: readonly IntentBoundReflexPayload[];
  memoryInfluences: readonly MemoryInfluencePayload[];
}

function replayOptions(value: string | ReplayProjectionOptions | undefined): ReplayProjectionOptions & { policyVersion: string } {
  if (typeof value === "string") return { policyVersion: value };
  return {
    policyVersion: value?.policyVersion ?? "jevyr.bone/1",
    ...(value?.intentContract === undefined ? {} : { intentContract: value.intentContract }),
    ...(value?.verifiedEvidenceEdges === undefined ? {} : { verifiedEvidenceEdges: value.verifiedEvidenceEdges }),
    ...(value?.formalProofKernelDigest === undefined ? {} : { formalProofKernelDigest: value.formalProofKernelDigest }),
    ...(value?.verifiedOriginalSubjectEdges === undefined ? {} : { verifiedOriginalSubjectEdges: value.verifiedOriginalSubjectEdges }),
    ...(value?.originalSubjectContext === undefined ? {} : { originalSubjectContext: value.originalSubjectContext }),
  };
}

export interface ReplayResult extends EventProjection {
  verdict: ReturnType<typeof compileVerdict>;
  reflex: IntentBoundReflexPayload;
  eventHeadDigest: string;
  crystallizable: boolean;
}

function authority(payload: EvidencePayload): EvidenceAuthority {
  switch (payload.evidenceType) {
    case "subject_snapshot": return "subject_snapshot";
    case "tool_observation": return "deterministic_tool";
    case "sandbox_execution": return "sandbox_execution";
    case "original_subject_assertions": return "original_subject_assertions";
    case "artifact": return "artifact_inspection";
    case "model_report": return "model_report";
    case "peer_report": return "peer_report";
    case "memory_hint": return "memory_hint";
  }
}

function carriesClaimedVerdictEdge(payload: EvidencePayload): boolean {
  return (payload.supports?.length ?? 0) > 0 || (payload.refutes?.length ?? 0) > 0;
}

function verifiedEdgeKey(edge: VerifiedEvidenceEdge): string {
  return JSON.stringify([
    edge.eventDigest,
    edge.evidenceId,
    edge.contentDigest,
    edge.targetId,
    edge.kind,
  ]);
}

function updatedCandidate(previous: CandidateAssessment | undefined, payload: CandidatePayload): CandidateAssessment {
  const feasibility: Feasibility = payload.feasibility ?? previous?.feasibility ?? "LAWFUL_BUT_OPEN";
  return {
    id: payload.candidateId,
    feasibility,
    survived: payload.status === "invalidated" ? false : payload.status === "survived" || payload.status === "selected" ? true : previous?.survived ?? false,
    selected: payload.status === "selected" || previous?.selected === true,
    embodiment: payload.status === "embodied" ? "built" : previous?.embodiment ?? "not_built",
  };
}

function updatedAssay(previous: AssayAssessment | undefined, payload: AssayPayload): AssayAssessment {
  return {
    id: payload.assayId,
    status: payload.status,
    critical: payload.critical,
    evidenceIds: [...(payload.evidenceIds ?? previous?.evidenceIds ?? [])],
    ...(payload.obligationId === undefined && previous?.obligationId === undefined ? {} : { obligationId: payload.obligationId ?? previous?.obligationId as string }),
    ...(payload.candidateId === undefined && previous?.candidateId === undefined ? {} : { candidateId: payload.candidateId ?? previous?.candidateId as string }),
    ...(payload.scope === undefined ? {} : { scope: payload.scope, populationIds: payload.populationIds ?? [] }),
  };
}

export function projectEvents(events: readonly CaseEvent[], optionsOrPolicyVersion?: string | ReplayProjectionOptions): EventProjection {
  const options = replayOptions(optionsOrPolicyVersion);
  if (options.intentContract) assertIntentContract(options.intentContract);
  const graph = new EvidenceGraph();
  const obligations = new Map<string, Obligation>((options.intentContract ? obligationsFromIntentContract(options.intentContract) : []).map((entry) => [entry.id, entry]));
  const sealedObligationIds = new Set(obligations.keys());
  for (const obligation of obligations.values()) {
    graph.addNode({
      id: obligation.id,
      kind: "claim",
      authority: "model_report",
      summary: obligation.statement,
      contentDigest: digestJson({ intentContractDigest: options.intentContract?.digest ?? null, obligation } as unknown as JsonValue),
      metadata: { source: "intent_contract", assayability: obligation.assayability ?? "assayable" },
    });
  }
  const candidates = new Map<string, CandidateAssessment>();
  const assays = new Map<string, AssayAssessment>();
  const issues: IntegrityIssue[] = options.intentContract === undefined
    ? [{ code: "INTENT_CONTRACT_MISSING", summary: "Replay lacks the sealed intent contract and cannot reconstruct its obligations.", severity: "fatal", phase: "pre_judgment" }]
    : [];
  const verifiedEdges = new Map<string, VerifiedEvidenceEdge>();
  const duplicateVerifiedEdgeKeys = new Set<string>();
  for (const edge of options.verifiedEvidenceEdges ?? []) {
    const key = verifiedEdgeKey(edge);
    if (verifiedEdges.has(key)) duplicateVerifiedEdgeKeys.add(key);
    else verifiedEdges.set(key, edge);
  }
  for (const key of duplicateVerifiedEdgeKeys) {
    verifiedEdges.delete(key);
    issues.push({
      code: "DUPLICATE_VERIFIED_EVIDENCE_EDGE",
      summary: `The verified evidence-edge allowlist contains a duplicate tuple ${key}.`,
      severity: "fatal",
      phase: "pre_judgment",
    });
  }
  const consumedVerifiedEdges = new Set<string>();
  const originalEdges = new Map<string, VerifiedEvidenceEdge>(), consumedOriginalEdges = new Set<string>(), duplicateOriginal = new Set<string>();
  for (const edge of options.verifiedOriginalSubjectEdges ?? []) {
    const key = verifiedEdgeKey(edge);
    if (originalEdges.has(key)) duplicateOriginal.add(key); else originalEdges.set(key, edge);
  }
  for (const key of duplicateOriginal) {
    originalEdges.delete(key);
    issues.push({ code: "DUPLICATE_ORIGINAL_SUBJECT_EDGE", summary: "Original-subject authority contains a repeated verified tuple.", severity: "fatal", phase: "pre_judgment" });
  }
  const originalPurpose = originalSubjectPurpose({ policyVersion: options.policyVersion, intentContractDigest: options.intentContract?.digest ?? UNBOUND_INTENT_CONTRACT_DIGEST,
    ...(options.intentContract === undefined ? {} : { intentContract: options.intentContract }),
    ...(options.originalSubjectContext === undefined ? {} : { originalSubjectContext: options.originalSubjectContext }), obligations: [...obligations.values()] });
  const reflexReports: IntentBoundReflexPayload[] = [];
  const memoryInfluences: MemoryInfluencePayload[] = [];
  let creationFailed = false;

  for (const event of events) {
    if (event.kind === "claim.published") {
      const payload = event.payload;
      try {
        if (!sealedObligationIds.has(payload.claimId)) {
          graph.addNode({
            id: payload.claimId,
            kind: "claim",
            authority: "model_report",
            summary: payload.statement,
            contentDigest: digestJson(payload as unknown as JsonValue),
            ...(payload.candidateId === undefined ? {} : { candidateId: payload.candidateId }),
          });
        }
        if (payload.claimType === "requirement") {
          const existing = obligations.get(payload.claimId);
          if (existing && existing.statement !== payload.statement) {
            issues.push({ code: "SEALED_OBLIGATION_MUTATION", summary: `Claim ${payload.claimId} conflicts with the sealed obligation.`, severity: "fatal", phase: "pre_judgment" });
          } else if (!existing) {
            issues.push({ code: "UNSEALED_OBLIGATION", summary: `Requirement ${payload.claimId} was introduced after the intent contract was sealed.`, severity: "fatal", phase: "pre_judgment" });
          }
        }
      } catch (error) {
        issues.push({ code: "DUPLICATE_OR_INVALID_CLAIM", summary: (error as Error).message, severity: "fatal", phase: "pre_judgment" });
      }
    } else if (event.kind === "evidence.observed") {
      const payload = event.payload;
      try {
        graph.addNode({
          id: payload.evidenceId,
          kind: payload.evidenceType === "subject_snapshot" ? "subject_snapshot" : payload.evidenceType === "artifact" ? "artifact" : "observation",
          authority: authority(payload),
          summary: payload.summary,
          contentDigest: payload.contentDigest,
          ...(payload.audit === undefined ? {} : { metadata: { audit: payload.audit as unknown as JsonValue } }),
        });
        if (payload.audit !== undefined && (event.actor.kind !== "kernel" && event.actor.kind !== "tool" || payload.evidenceType !== "tool_observation" || payload.contentDigest !== digestJson(payload.audit as unknown as JsonValue))) {
          issues.push({ code: "UNTRUSTED_AUDIT_RECEIPT", summary: `Audit ${payload.evidenceId} lacks a digest-bound runtime source.`, severity: "fatal", phase: "pre_judgment", evidenceIds: [payload.evidenceId] });
        }
        if (payload.evidenceType === "original_subject_assertions") {
          const binding = payload.originalSubject;
          const valid = validateCaseEventShape(event).ok && originalPurpose !== undefined && binding !== undefined
            && event.caseDigest === originalPurpose.caseDigest && event.runDigest === originalPurpose.runDigest
            && binding.subjectId === originalPurpose.subjectId && binding.obligationId === originalPurpose.obligationId
            && binding.captureDigest === originalPurpose.captureDigest && binding.kernelDigest === options.originalSubjectContext?.kernelDigest;
          if (!valid) issues.push({ code: "ORIGINAL_SUBJECT_BINDING_INVALID", summary: "Original-subject evidence lacks the exact sealed Case, purpose, kernel or protocol binding.", severity: "fatal", phase: "pre_judgment", evidenceIds: [payload.evidenceId] });
          else for (const kind of ["supports", "refutes"] as const) for (const targetId of payload[kind] ?? []) {
            const key = verifiedEdgeKey({ eventDigest: event.eventDigest, evidenceId: payload.evidenceId, contentDigest: payload.contentDigest, targetId, kind });
            if (originalEdges.has(key) && !consumedOriginalEdges.has(key)) {
              graph.addVerifiedOriginalSubjectEdge({ id: `${payload.evidenceId}:${kind}:${targetId}`, from: payload.evidenceId, to: targetId, kind }); consumedOriginalEdges.add(key);
            } else issues.push({ code: "UNVERIFIED_ORIGINAL_SUBJECT_EDGE", summary: "Original-subject evidence claimed authority without its separate exact independently verified tuple.", severity: "fatal", phase: "pre_judgment", evidenceIds: [payload.evidenceId] });
          }
        } else if (payload.evidenceType === "sandbox_execution") {
          for (const target of [...(payload.supports ?? [])].sort()) {
            const edge: VerifiedEvidenceEdge = {
              eventDigest: event.eventDigest,
              evidenceId: payload.evidenceId,
              contentDigest: payload.contentDigest,
              targetId: target,
              kind: "supports",
            };
            const key = verifiedEdgeKey(edge);
            if (verifiedEdges.has(key) && !consumedVerifiedEdges.has(key)) {
              graph.addEdge({ id: `${payload.evidenceId}:supports:${target}`, from: payload.evidenceId, to: target, kind: "supports" });
              consumedVerifiedEdges.add(key);
            } else {
              issues.push({
                code: "UNVERIFIED_EVIDENCE_EDGE",
                summary: `Sandbox evidence ${payload.evidenceId} claimed support without an exact independently verified authority tuple.`,
                severity: "fatal",
                phase: "pre_judgment",
                evidenceIds: [payload.evidenceId],
              });
            }
          }
          for (const target of [...(payload.refutes ?? [])].sort()) {
            const edge: VerifiedEvidenceEdge = {
              eventDigest: event.eventDigest,
              evidenceId: payload.evidenceId,
              contentDigest: payload.contentDigest,
              targetId: target,
              kind: "refutes",
            };
            const key = verifiedEdgeKey(edge);
            if (verifiedEdges.has(key) && !consumedVerifiedEdges.has(key)) {
              graph.addEdge({ id: `${payload.evidenceId}:refutes:${target}`, from: payload.evidenceId, to: target, kind: "refutes" });
              consumedVerifiedEdges.add(key);
            } else {
              issues.push({
                code: "UNVERIFIED_EVIDENCE_EDGE",
                summary: `Sandbox evidence ${payload.evidenceId} claimed refutation without an exact independently verified authority tuple.`,
                severity: "fatal",
                phase: "pre_judgment",
                evidenceIds: [payload.evidenceId],
              });
            }
          }
        } else if (carriesClaimedVerdictEdge(payload)) {
          issues.push({
            code: "UNVERIFIED_EVIDENCE_EDGE",
            summary: `Evidence ${payload.evidenceId} of type ${payload.evidenceType} claimed a verdict edge without a replayable sandbox oracle substrate.`,
            severity: "fatal",
            phase: "pre_judgment",
            evidenceIds: [payload.evidenceId],
          });
        }
      } catch (error) {
        issues.push({ code: "INVALID_EVIDENCE_LINK", summary: (error as Error).message, severity: "fatal", phase: "pre_judgment", evidenceIds: [payload.evidenceId] });
      }
    } else if (event.kind === "candidate.status") {
      candidates.set(event.payload.candidateId, updatedCandidate(candidates.get(event.payload.candidateId), event.payload));
    } else if (event.kind === "assay.status") {
      assays.set(event.payload.assayId, updatedAssay(assays.get(event.payload.assayId), event.payload));
      if (event.payload.candidateId && event.payload.status === "failed") {
        const candidate = candidates.get(event.payload.candidateId);
        if (candidate) candidates.set(candidate.id, { ...candidate, embodiment: "failed" });
      }
    } else if (event.kind === "action.status" && event.actor.kind === "kernel" && event.payload.status === "failed" && ["integrity.sandbox_failure", "integrity.provider_failure", "integrity.capability_loss"].includes(event.payload.actionType)) {
      issues.push({ code: event.payload.actionType.slice("integrity.".length).toUpperCase(), summary: event.payload.summary, severity: "fatal", phase: "pre_judgment" });
    } else if (event.kind === "stage.status" && event.payload.status === "failed" && (event.stage === "diverge" || event.stage === "recombine")) {
      creationFailed = true;
    } else if (event.kind === "reflex.completed") {
      // A first Reflex can deliberately distrust all authority until its one
      // independent replay. Bind that view explicitly instead of comparing it
      // to the later, authority-enabled graph reconstructed on final replay.
      let reviewedGraph = graph;
      if (event.payload.loop === 1 && event.payload.decision === "repeat_once" && event.payload.reviewedEvidenceDigest !== graph.digest()) {
        const snapshot = graph.snapshot();
        reviewedGraph = EvidenceGraph.from({ nodes: snapshot.nodes, edges: snapshot.edges.filter((edge) => edge.kind !== "supports" && edge.kind !== "refutes") });
      }
      if (event.payload.reviewedEvidenceDigest !== reviewedGraph.digest()) {
        issues.push({ code: "REFLEX_DIGEST_MISMATCH", summary: `Reflex loop ${event.payload.loop} did not review the evidence state present at that point.`, severity: "fatal", phase: "post_judgment" });
      }
      if (event.payload.audits !== undefined && event.payload.reviewedEvidenceDigest === reviewedGraph.digest()) {
        const reviewedInput: PolicyInput = {
          policyVersion: options.policyVersion,
          intentContractDigest: options.intentContract?.digest ?? UNBOUND_INTENT_CONTRACT_DIGEST,
          ...(options.intentContract === undefined ? {} : { intentContract: options.intentContract }),
          ...(options.formalProofKernelDigest === undefined ? {} : { formalProofKernelDigest: options.formalProofKernelDigest }),
          ...(options.originalSubjectContext === undefined ? {} : { originalSubjectContext: options.originalSubjectContext }),
          graph: reviewedGraph,
          obligations: [...obligations.values()], candidates: [...candidates.values()], assays: [...assays.values()], integrityIssues: issues,
          auditEvents: events.filter((entry) => entry.sequence < event.sequence), creationFailed,
        };
        const recomputed = evaluateReflex(compileVerdict(reviewedInput), reviewedInput, { loop: event.payload.loop, canAcquireMaterialEvidence: event.payload.decision === "repeat_once" });
        if (digestJson(recomputed as unknown as JsonValue) !== digestJson(event.payload as unknown as JsonValue)) issues.push({ code: "REFLEX_REPORT_MISMATCH", summary: `Reflex loop ${event.payload.loop} does not reproduce from its recorded evidence and runtime audit receipts.`, severity: "fatal", phase: "post_judgment" });
      }
      reflexReports.push(structuredClone(event.payload) as IntentBoundReflexPayload);
    } else if (event.kind === "memory.influence") {
      memoryInfluences.push(structuredClone(event.payload));
    }
  }

  for (const [key, edge] of verifiedEdges) {
    if (!consumedVerifiedEdges.has(key)) {
      issues.push({
        code: "UNUSED_VERIFIED_EVIDENCE_EDGE",
        summary: `Verified authority tuple for evidence ${edge.evidenceId} does not exactly match a claimed public sandbox edge.`,
        severity: "fatal",
        phase: "pre_judgment",
        evidenceIds: [edge.evidenceId],
      });
    }
  }
  for (const [key, edge] of originalEdges) if (!consumedOriginalEdges.has(key)) issues.push({ code: "UNUSED_ORIGINAL_SUBJECT_EDGE", summary: "A verified original-subject tuple does not exactly match a claimed public original-subject edge.", severity: "fatal", phase: "pre_judgment", evidenceIds: [edge.evidenceId] });

  const input: PolicyInput = {
    policyVersion: options.policyVersion,
    intentContractDigest: options.intentContract?.digest ?? UNBOUND_INTENT_CONTRACT_DIGEST,
    ...(options.intentContract === undefined ? {} : { intentContract: options.intentContract }),
    ...(options.formalProofKernelDigest === undefined ? {} : { formalProofKernelDigest: options.formalProofKernelDigest }),
    ...(options.originalSubjectContext === undefined ? {} : { originalSubjectContext: options.originalSubjectContext }),
    graph,
    obligations: [...obligations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    candidates: [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id)),
    assays: [...assays.values()].sort((a, b) => a.id.localeCompare(b.id)),
    integrityIssues: issues,
    creationFailed,
    auditEvents: events,
  };
  return { graph, input, reflexReports, memoryInfluences };
}

export function replayCase(events: readonly CaseEvent[], optionsOrPolicyVersion?: string | ReplayProjectionOptions): ReplayResult {
  const chain = verifyEventChain(events);
  const projection = projectEvents(events, optionsOrPolicyVersion);
  if (!chain.valid) {
    projection.input = {
      ...projection.input,
      integrityIssues: [
        ...(projection.input.integrityIssues ?? []),
        ...chain.problems.map((problem) => ({ code: `LEDGER_${problem.code.toUpperCase()}`, summary: problem.message, severity: "fatal" as const, phase: "pre_judgment" as const })),
      ],
    };
  }
  let verdict = compileVerdict(projection.input);
  let reflex: IntentBoundReflexPayload;
  let crystallizable = true;
  try {
    reflex = assertReflexComplete(verdict, projection.reflexReports);
  } catch (error) {
    const last = projection.reflexReports.at(-1);
    if (last === undefined) throw error;
    crystallizable = false;
    projection.input = {
      ...projection.input,
      integrityIssues: [
        ...(projection.input.integrityIssues ?? []),
        { code: "REFLEX_INVALID", summary: (error as Error).message, severity: "fatal", phase: "post_judgment" },
      ],
    };
    verdict = compileVerdict(projection.input);
    reflex = last;
  }
  if (chain.headDigest === null) throw new Error("Cannot replay an empty case ledger");
  return { ...projection, verdict, reflex, eventHeadDigest: chain.headDigest, crystallizable };
}
