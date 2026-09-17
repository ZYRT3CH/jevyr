import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createSearchEnvelope, digestJson, sha256Digest, validateCaseEventShape, validateSealedCase, type CaseEvent, type EvidencePayload, type JsonValue, type SealedCase } from "@jevyr/protocol";
import { compileVerdict, createCaseEvent, evaluateReflex, EvidenceGraph, JEVYR_BONE_DESCRIPTOR, JEVYR_BONE_DIGEST, JEVYR_BONE_V2_DESCRIPTOR, JEVYR_BONE_V2_DIGEST,
  ORIGINAL_SUBJECT_POLICY_VERSION, ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST, originalSubjectKernelDigestFromPolicyDescriptor, originalSubjectPurpose,
  projectEvents, sealCase, REGO_POLICY_SOURCE_DIGEST, REGO_POLICY_WASM_DIGEST, type CandidateAssessment, type ReplayProjectionOptions, type VerifiedEvidenceEdge } from "../src/index.js";

const hash = (value: unknown) => digestJson(value as JsonValue);
const searchEnvelope = createSearchEnvelope({ attemptSafetyCeiling: "20", nursery: { minimumAttempts: 1, saturationWindow: 1, independentLineages: 1, challengeInterval: 1 }, seedDerivation: "sha256-case-seed-frontier-v2",
  resources: { maxMindInvocations: 1, maxInputTokens: 100, maxOutputTokens: 100, maxWallMillis: 1000, maxSingleInvocationMillis: 1000, maxGeneratedBytes: 1000,
    maxForgeCpuMillis: 1000, maxForgeWallMillis: 1000, maxMemorySeconds: 1000, maxWritableBytes: 1000, maxWritableInodes: 100, maxArtifactBytes: 1000,
    maxNetworkBytes: 0, concurrentLineages: 1, maxTotalAssayCost: 1 } });
function sealed(impulse = "Existing tests must pass.", policyVersion = ORIGINAL_SUBJECT_POLICY_VERSION as string, extra: { constraints?: string[]; requestedAssays?: string[] } = {}): SealedCase {
  return sealCase({ protocol: "jevyr.case/1", case: { impulse, subjects: [{ id: "original", kind: "directory", locator: "/private/original" }], ...extra } }, {
    policyVersion, policyDigest: hash({ policyVersion }), genomeVersion: "fixture", genomeDigest: hash("genome"), subjectMaterialCaptureDigest: hash("capture"), searchEnvelope,
    sealedAt: "2026-09-05T00:00:00.000Z", subjectSnapshots: [{ subjectId: "original", digest: hash("original bytes"), byteLength: 12, resolvedLocator: "/private/original", capturedAt: "2026-09-05T00:00:00.000Z" }] });
}
function fixture(kind: "supports" | "refutes" = "supports", original = sealed()) {
  const obligationId = original.intentContract.criticalObligations[0]!.id;
  const contentDigest = hash({ result: kind }), payload: EvidencePayload = { evidenceId: `original-${kind}`, evidenceType: "original_subject_assertions", summary: "An independently reconstructed original-source assertion certificate.", contentDigest,
    originalSubject: { protocol: "jevyr.original-subject-assertion-binding/1", subjectId: "original", obligationId, captureDigest: original.subjectMaterialCaptureDigest,
      certificateDigest: contentDigest, executionReceiptDigest: hash("receipt"), kernelDigest: ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST }, [kind]: [obligationId] };
  const event = createCaseEvent({ caseDigest: original.caseDigest, runDigest: original.runDigest, observedAt: "2026-09-05T00:00:01.000Z", stage: "assay", kind: "evidence.observed", actor: { kind: "kernel", id: "jevyr.bone" }, payload }, 1, null);
  const edge: VerifiedEvidenceEdge = { eventDigest: event.eventDigest, evidenceId: payload.evidenceId, contentDigest, targetId: obligationId, kind };
  const options: ReplayProjectionOptions = { policyVersion: original.policyVersion, intentContract: original.intentContract, originalSubjectContext: { sealedCase: original, kernelDigest: ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST }, verifiedOriginalSubjectEdges: [edge] };
  return { sealed: original, event, edge, options, obligationId };
}
function projection(f = fixture(), patch: Partial<ReplayProjectionOptions> = {}) { return projectEvents([f.event], { ...f.options, ...patch }); }

describe("explicit v2 original-subject authority", () => {
  it("keeps both original Rego/Wasm bytes and default Bone v1 unchanged", () => {
    expect(sha256Digest(readFileSync(new URL("../policy/judgment.rego", import.meta.url)))).toBe(REGO_POLICY_SOURCE_DIGEST);
    expect(sha256Digest(readFileSync(new URL("../policy/judgment.wasm", import.meta.url)))).toBe(REGO_POLICY_WASM_DIGEST);
    expect(REGO_POLICY_SOURCE_DIGEST).toBe("sha256:62c81ee15f7f4b26d4ab3f1b786ffcb11a38f9560eb8c2e429a38f86154756cc");
    expect(REGO_POLICY_WASM_DIGEST).toBe("sha256:d5db6164f700a00dedd3d7626b149947a8c16f237eba23fb197337f2f0ab386f");
    expect(JEVYR_BONE_DESCRIPTOR.version).toBe("bone-v1"); expect(JEVYR_BONE_V2_DIGEST).not.toBe(JEVYR_BONE_DIGEST);
  });
  it("accepts original support with truthful FAILED/NOT_BUILT axes and mandatory Reflex", () => {
    const f = fixture(), { input } = projection(f); expect(validateSealedCase(f.sealed).ok).toBe(true); expect(originalSubjectPurpose(input)).toBeDefined();
    const verdict = compileVerdict(input);
    expect(verdict).toMatchObject({ policyVersion: ORIGINAL_SUBJECT_POLICY_VERSION, integrity: "VALID", creation: "FAILED", embodiment: "NOT_BUILT", judgment: "ACCEPT" });
    expect(verdict.selectedCandidateId).toBeUndefined(); expect(input.candidates).toEqual([]); expect(input.assays).toEqual([]);
    expect(evaluateReflex(verdict, input, { loop: 1, canAcquireMaterialEvidence: false })).toMatchObject({ decision: "confirm", materialFindings: [] });
    expect(verdict.basis.find(entry => entry.code === "SEALED_OBLIGATIONS_SATISFIED")?.evidenceIds).toEqual([f.edge.evidenceId]);
  });
  it("requires a separate exact independently verified tuple, not sandbox authority or labels", () => {
    const f = fixture();
    for (const patch of [{ verifiedOriginalSubjectEdges: [] }, { verifiedOriginalSubjectEdges: [], verifiedEvidenceEdges: [f.edge] },
      { verifiedOriginalSubjectEdges: [f.edge, f.edge] }, { verifiedOriginalSubjectEdges: [{ ...f.edge, contentDigest: hash("forged") }] },
      { verifiedOriginalSubjectEdges: [{ ...f.edge, eventDigest: hash("foreign") }] }, { verifiedOriginalSubjectEdges: [{ ...f.edge, kind: "refutes" as const }] }]) {
      expect(compileVerdict(projection(f, patch).input)).toMatchObject({ integrity: "INVALID", judgment: "NOT_APPLICABLE" });
    }
    const projected = projection(f), snapshot = projected.graph.snapshot(), copied = EvidenceGraph.from(snapshot);
    expect(compileVerdict({ ...projected.input, graph: copied }).judgment).toBe("UNPROVEN");
    expect(projected.graph.strongestSupport(f.obligationId).weight).toBe(0);
    expect(projected.graph.strongestSupport(f.obligationId, true).weight).toBe(5);
    const display = projected.graph.withDisplaySummaries(new Map([[f.obligationId, "Praise-free display wording"]]));
    expect(compileVerdict({ ...projected.input, graph: display }).judgment).toBe("ACCEPT");
    expect(display.node(f.obligationId)?.contentDigest).toBe(projected.graph.node(f.obligationId)?.contentDigest);
    expect(() => projected.graph.withDisplaySummaries(new Map([["unknown", "cannot add nodes"]]))).toThrow();
    expect(compileVerdict({ ...projected.input, graph: copied.withDisplaySummaries(new Map()) }).judgment).toBe("UNPROVEN");
  });
  it("refuses malformed payloads, scoped aliases, foreign capture, actors and mutated certificates", () => {
    const f = fixture();
    for (const patch of [{ candidateId: "fake" }, { assayId: "fake" }, { originalSubject: undefined }, { audit: {} }, { formalProof: {} },
      { contentDigest: hash("changed") }, { supports: [] }, { refutes: [f.obligationId] }, { originalSubject: { ...f.event.payload.originalSubject, extra: true } }]) {
      expect(validateCaseEventShape({ ...f.event, payload: { ...f.event.payload, ...patch } }).ok).toBe(false);
    }
    expect(validateCaseEventShape({ ...f.event, actor: { id: "model", kind: "mind" } }).ok).toBe(false);
    const foreign = { ...f.event, payload: { ...f.event.payload, originalSubject: { ...f.event.payload.originalSubject!, captureDigest: hash("foreign") } } } as CaseEvent;
    expect(compileVerdict(projectEvents([foreign], f.options).input).judgment).toBe("NOT_APPLICABLE");
  });
  it("cannot waive creation or admit original edges with old kernels, labels, missing context, or altered full Cases", () => {
    const f = fixture(), tampered = structuredClone(f.sealed); tampered.intent.constraints = ["secretly qualified"];
    for (const patch of [{ policyVersion: "jevyr.bone/1" }, { policyVersion: "custom-historical-label" }, { originalSubjectContext: { sealedCase: f.sealed, kernelDigest: hash("old") } },
      { originalSubjectContext: { sealedCase: tampered, kernelDigest: ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST } }]) {
      expect(compileVerdict(projection(f, patch).input).judgment).not.toBe("ACCEPT");
    }
    const { originalSubjectContext: _ignored, ...options } = f.options;
    expect(compileVerdict(projectEvents([f.event], options).input).judgment).not.toBe("ACCEPT");
    for (const original of [sealed("Existing tests must pass. Also improve performance."), sealed("Existing tests must pass.", ORIGINAL_SUBJECT_POLICY_VERSION, { constraints: ["only happy paths"] }),
      sealed("Existing tests must pass.", ORIGINAL_SUBJECT_POLICY_VERSION, { requestedAssays: ["skip one"] }), sealed("Existing tests must pass.", "bone-v1")]) {
      expect(compileVerdict(projection(fixture("supports", original)).input).judgment).not.toBe("ACCEPT");
    }
    const input = projection().input;
    expect(originalSubjectPurpose({ ...input, obligations: input.obligations.map(item => ({ ...item, assayability: "unassayable" })) })).toBeUndefined();
  });
  it("preserves TS/Wasm parity for support/refutation/contradiction, all creation axes and integrity boundaries", () => {
    for (const result of ["supports", "refutes", "contradiction"] as const) for (const candidate of ["none", "survived", "failed"] as const) for (const fatal of ["none", "pre_judgment", "post_judgment"] as const) {
      const f = fixture(result === "refutes" ? "refutes" : "supports"), events = [f.event], edges = [f.edge];
      if (result === "contradiction") {
        const other = fixture("refutes", f.sealed), event = createCaseEvent({ ...other.event, observedAt: "2026-09-05T00:00:02.000Z" }, 2, f.event.eventDigest);
        events.push(event); edges.push({ ...other.edge, eventDigest: event.eventDigest });
      }
      const { input } = projectEvents(events, { ...f.options, verifiedOriginalSubjectEdges: edges });
      const candidates: CandidateAssessment[] = candidate === "none" ? [] : [{ id: "real-optional-candidate", feasibility: "BUILDABLE_NOW", survived: candidate === "survived", selected: candidate === "survived", embodiment: candidate === "failed" ? "failed" : "built" }];
      const verdict = compileVerdict({ ...input, candidates, integrityIssues: fatal === "none" ? [] : [{ code: "FATAL", summary: "Measured integrity fault", severity: "fatal", phase: fatal }] });
      expect(verdict.judgment).toBe(fatal === "pre_judgment" ? "NOT_APPLICABLE" : result === "supports" ? "ACCEPT" : "REJECT");
      expect(verdict.creation).toBe(candidate === "none" ? "FAILED" : candidate === "survived" ? "CONCEIVED" : "NO_SURVIVOR");
      expect(verdict.integrity).toBe(fatal === "none" ? "VALID" : "INVALID");
    }
  });
  it("recognizes only exact current v2 kernel selection from the sealed policy descriptor", () => {
    const descriptor = (bone: unknown) => { const selection = { runtimeCompilation: { bone, boneDigest: hash(bone) } }; return { policy: { genomeSelection: selection, genomeSelectionDigest: hash(selection) } }; };
    expect(originalSubjectKernelDigestFromPolicyDescriptor(descriptor(JEVYR_BONE_V2_DESCRIPTOR))).toBe(ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST);
    expect(originalSubjectKernelDigestFromPolicyDescriptor(descriptor(JEVYR_BONE_DESCRIPTOR))).toBeUndefined();
    expect(originalSubjectKernelDigestFromPolicyDescriptor(descriptor({ ...JEVYR_BONE_V2_DESCRIPTOR, policyKernel: JEVYR_BONE_DESCRIPTOR.policyKernel }))).toBeUndefined();
    expect(originalSubjectKernelDigestFromPolicyDescriptor(descriptor({ ...JEVYR_BONE_V2_DESCRIPTOR, originalSubjectAssertionKernel: { ...JEVYR_BONE_V2_DESCRIPTOR.originalSubjectAssertionKernel, implementationDigest: hash("forged") } }))).toBeUndefined();
  });
  it("judges clean original and defective generated material separately, including closed candidate populations", () => {
    for (const originalOutcome of ["supports", "refutes"] as const) for (const candidateOutcome of ["supports", "refutes"] as const) {
      const f = fixture(originalOutcome), events: CaseEvent[] = [f.event];
      const candidateEvent = createCaseEvent({ caseDigest: f.sealed.caseDigest, runDigest: f.sealed.runDigest, observedAt: "2026-09-05T00:00:02.000Z", stage: "recombine", kind: "candidate.status", actor: { id: "mind", kind: "mind" },
        payload: { candidateId: "generated", status: "selected", feasibility: candidateOutcome === "refutes" ? "CONTRADICTED" : "BUILDABLE_NOW", summary: "Actual separate candidate assessment." } }, 2, f.event.eventDigest);
      events.push(candidateEvent);
      const sandbox = createCaseEvent({ caseDigest: f.sealed.caseDigest, runDigest: f.sealed.runDigest, observedAt: "2026-09-05T00:00:03.000Z", stage: "assay", kind: "evidence.observed", actor: { id: "forge", kind: "tool" },
        payload: { evidenceId: "candidate-result", evidenceType: "sandbox_execution", contentDigest: hash({ candidateOutcome }), summary: "Executed generated material", candidateId: "generated", assayId: "candidate-assay", [candidateOutcome]: [f.obligationId] } }, 3, candidateEvent.eventDigest);
      events.push(sandbox);
      const assay = createCaseEvent({ caseDigest: f.sealed.caseDigest, runDigest: f.sealed.runDigest, observedAt: "2026-09-05T00:00:04.000Z", stage: "assay", kind: "assay.status", actor: { id: "bone", kind: "kernel" },
        payload: { assayId: "candidate-assay", candidateId: "generated", obligationId: f.obligationId, status: candidateOutcome === "refutes" ? "failed" : "passed", critical: true, summary: "Candidate scoped result", evidenceIds: [sandbox.payload.evidenceId] } }, 4, sandbox.eventDigest);
      events.push(assay);
      const verifiedEvidenceEdges = [{ eventDigest: sandbox.eventDigest, evidenceId: sandbox.payload.evidenceId, contentDigest: sandbox.payload.contentDigest, targetId: f.obligationId, kind: candidateOutcome }];
      const input = projectEvents(events, { ...f.options, verifiedEvidenceEdges }).input;
      for (const extra of [[], [{ id: "candidate-open", candidateId: "generated", obligationId: f.obligationId, critical: true, status: "blocked" as const, evidenceIds: [] }],
        [{ id: "population-failed", scope: "closed_population" as const, populationIds: ["generated"], critical: true, status: "failed" as const, evidenceIds: [sandbox.payload.evidenceId] }]]) {
        const state = { ...input, assays: [...input.assays, ...extra] }, verdict = compileVerdict(state);
        expect(verdict.judgment).toBe(originalOutcome === "supports" ? "ACCEPT" : "REJECT");
        expect(verdict.basis.some(entry => entry.code === "CANDIDATE_ASSAY_ASSESSMENT")).toBe(true);
        expect(evaluateReflex(verdict, state, { loop: 1, canAcquireMaterialEvidence: false }).materialFindings).toEqual([]);
        if (candidateOutcome === "refutes") expect(verdict).toMatchObject({ creation: "NO_SURVIVOR", embodiment: "FAILED" });
      }
      const onlyCandidate = projectEvents(events.slice(1), { ...f.options, verifiedOriginalSubjectEdges: [], verifiedEvidenceEdges }).input;
      expect(compileVerdict(onlyCandidate).judgment).toBe("UNPROVEN");
    }
  });
  it("preserves non-candidate critical guards and duplicate-selection coherence without falsely refuting original source", () => {
    const input = projection().input;
    for (const status of ["failed", "blocked"] as const) {
      const state = { ...input, assays: [{ id: "global-guard", critical: true, status, evidenceIds: [] }] }, verdict = compileVerdict(state);
      expect(verdict.judgment).toBe(status === "failed" ? "REJECT" : "UNPROVEN");
      if (status === "blocked") expect(evaluateReflex(verdict, state, { loop: 1, canAcquireMaterialEvidence: false }).materialFindings.map(item => item.code)).toContain("UNRESOLVED_ASSAY");
    }
    const candidates: CandidateAssessment[] = ["a", "b"].map(id => ({ id, survived: true, selected: true, feasibility: "BUILDABLE_NOW", embodiment: "built" }));
    const state = { ...input, candidates }, verdict = compileVerdict(state);
    expect(verdict.judgment).toBe("UNPROVEN");
    expect(evaluateReflex(verdict, state, { loop: 1, canAcquireMaterialEvidence: false }).materialFindings.map(item => item.code)).toContain("AMBIGUOUS_SELECTION");
  });
  it("enforces original-subject assay scope inside the v2 Wasm module without host filtering", () => {
    const { loadPolicySync } = createRequire(import.meta.url)("@open-policy-agent/opa-wasm") as typeof import("@open-policy-agent/opa-wasm");
    const module = loadPolicySync(readFileSync(new URL("../policy/judgment-v2.wasm", import.meta.url)));
    const candidate = { id: "generated", survived: true, selected: true, feasibility: "BUILDABLE_NOW", embodiment: "built" };
    const evaluate = (assay: Record<string, unknown>, originalSubjectPurpose: boolean) => (module.evaluate({ originalSubjectPurpose,
      candidates: [candidate], assays: [assay], obligations: [{ id: "original", critical: true, assayability: "assayable", supportWeight: 5, refutationWeight: 0 }],
      integrityIssues: [], auditFindings: [], creationFailed: false }, "jevyr/bone/axes")[0]!.result as { judgment: string }).judgment;
    for (const scope of [{ candidateId: "generated" }, { scope: "closed_population", populationIds: ["generated"] }]) {
      for (const status of ["failed", "blocked"]) {
        const assay = { id: "candidate-only", critical: true, status, evidenceIds: [], ...scope };
        expect(evaluate(assay, true)).toBe("ACCEPT");
        expect(evaluate(assay, false)).toBe(status === "failed" ? "REJECT" : "UNPROVEN");
      }
    }
    expect(evaluate({ id: "global-guard", critical: true, status: "failed", evidenceIds: [] }, true)).toBe("REJECT");
  });
});
