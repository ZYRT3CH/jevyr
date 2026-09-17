import { describe, expect, it } from "vitest";
import { digestJson, type CaseEvent, type InvestigationAuditReceipt, type JsonValue } from "@jevyr/protocol";
import { assertReflexComplete, compileIntentContract, compileVerdict, createCaseEvent, evaluateInvestigationAudits, evaluateReflex, EvidenceGraph, projectEvents, type PolicyInput } from "../src/index.js";

const digest = (label: string) => digestJson({ label });
const intentContract = compileIntentContract({ impulse: "`node artifact.js` exits with code 0." });

function input(): PolicyInput {
  const graph = new EvidenceGraph();
  graph.addNode({ id: "obligation", kind: "claim", authority: "model_report", summary: "The executable succeeds.", contentDigest: digest("obligation") });
  graph.addNode({ id: "execution", kind: "observation", authority: "sandbox_execution", summary: "Independent sealed oracle execution.", contentDigest: digest("execution") });
  graph.addEdge({ id: "execution:obligation", from: "execution", to: "obligation", kind: "supports" });
  return { graph, intentContractDigest: intentContract.digest, obligations: [{ id: "obligation", statement: "The executable succeeds.", critical: true }], candidates: [{ id: "candidate", feasibility: "BUILDABLE_NOW", selected: true, survived: true, embodiment: "built" }], assays: [{ id: "assay", status: "passed", critical: true, evidenceIds: ["execution"], obligationId: "obligation" }] };
}

function receipt(state: PolicyInput, id: string, audit: InvestigationAuditReceipt): void {
  state.graph.addNode({ id, kind: "observation", authority: "deterministic_tool", summary: `Runtime audit ${id}`, contentDigest: digestJson(audit as unknown as JsonValue), metadata: { audit: audit as unknown as JsonValue } });
}

const lineage = (id: string): Extract<InvestigationAuditReceipt, { kind: "lineage_commitment" }> => ({ kind: "lineage_commitment", invocationId: id, providerId: "provider", modelId: "model", lineageId: id, seedCommitment: digest(id), seedEnforcement: "unverified", promptDigest: digest("blind-prompt"), candidateIds: [id], visibleCandidateIds: [], memoryDigests: [], assumptionDigest: digest("assumptions") });

function memoryEvent(memoryDigest: string, stage: "recombine" | "diverge" = "recombine"): CaseEvent<"memory.influence"> {
  return createCaseEvent({ caseDigest: digest("case"), runDigest: digest("run"), observedAt: "2026-09-05T00:00:00.000Z", stage, kind: "memory.influence", actor: { id: "archivist", kind: "archivist" }, payload: { memoryDigest, weight: 0.1, influence: "seeded_hypothesis", summary: "Recorded late hypothesis seed." } }, 1, null);
}

describe("deterministic investigation audits", () => {
  it("reports unmeasured independence and wording without blocking decisive evidence", () => {
    const state = input();
    receipt(state, "lineage-a", lineage("a"));
    receipt(state, "lineage-b", lineage("b"));
    const verdict = compileVerdict(state);
    const report = evaluateReflex(verdict, state, { loop: 1, canAcquireMaterialEvidence: false });
    expect(verdict.judgment).toBe("ACCEPT");
    expect(report.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ audit: "provider_seed_lineage_correlation", status: "unmeasured" }),
      expect.objectContaining({ audit: "preference_wording", status: "unmeasured" }),
    ]));
    expect(report.audits).toHaveLength(9);
  });

  it("reveals a shared provider and repeated seed rather than fabricating independence", () => {
    const state = input();
    receipt(state, "lineage-a", { ...lineage("a"), seedEnforcement: "honored" });
    receipt(state, "lineage-b", { ...lineage("b"), seedEnforcement: "honored", seedCommitment: digest("a") });
    expect(evaluateInvestigationAudits(state).audits).toContainEqual(expect.objectContaining({ audit: "provider_seed_lineage_correlation", status: "failed", summary: expect.stringContaining("1 provider(s)") }));
    expect(compileVerdict(state).judgment).toBe("ACCEPT");
  });

  it.each(["visibleCandidateIds", "memoryDigests"] as const)("invalidates leaked blind inputs through %s", (field) => {
    const state = input();
    receipt(state, "leaked", { ...lineage("a"), [field]: [field === "memoryDigests" ? digest("memory") : "prior-candidate"] });
    expect(compileVerdict(state)).toMatchObject({ integrity: "INVALID", judgment: "NOT_APPLICABLE" });
  });

  it("invalidates an altered evaluator oracle and downgrades builder/evaluator overlap", () => {
    const state = input();
    receipt(state, "overlap", { kind: "evaluator_boundary", builderId: "same", evaluatorId: "same", sealedOracleDigest: digest("oracle"), appliedOracleDigest: digest("oracle"), untrustedOracleInput: false });
    expect(compileVerdict(state).judgment).toBe("UNPROVEN");
    receipt(state, "mutation", { kind: "evaluator_boundary", builderId: "builder", evaluatorId: "evaluator", sealedOracleDigest: digest("oracle"), appliedOracleDigest: digest("changed"), untrustedOracleInput: false });
    expect(compileVerdict(state)).toMatchObject({ integrity: "INVALID", judgment: "NOT_APPLICABLE" });
  });

  it("invalidates hidden assumption changes", () => {
    const state = input();
    receipt(state, "assumptions", { kind: "assumption_check", sealedAssumptionsDigest: digest("original"), appliedAssumptionsDigest: digest("relaxed") });
    expect(compileVerdict(state).basis).toContainEqual(expect.objectContaining({ code: "REFLEX_HIDDEN_ASSUMPTION_CHANGE" }));
    expect(compileVerdict(state).integrity).toBe("INVALID");
  });

  it("downgrades selection made before blind divergence closes", () => {
    const state = input();
    const selected = createCaseEvent({ caseDigest: digest("case"), runDigest: digest("run"), observedAt: "2026-09-05T00:00:00.000Z", stage: "diverge", kind: "candidate.status", actor: { id: "bone", kind: "kernel" }, payload: { candidateId: "candidate", status: "selected", summary: "Selected prematurely." } }, 1, null);
    const closed = createCaseEvent({ caseDigest: digest("case"), runDigest: digest("run"), observedAt: "2026-09-05T00:00:01.000Z", stage: "diverge", kind: "stage.status", actor: { id: "bone", kind: "kernel" }, payload: { stage: "diverge", status: "completed", summary: "Blind commitments completed." } }, 2, selected.eventDigest);
    state.auditEvents = [selected, closed];
    expect(compileVerdict(state).judgment).toBe("UNPROVEN");
    expect(evaluateInvestigationAudits(state).audits).toContainEqual(expect.objectContaining({ audit: "premature_convergence", status: "failed" }));
  });

  it("takes transitive memory contamination closure across multiple generations", () => {
    const state = input();
    const root = digest("root"); const child = digest("child"); const grandchild = digest("grandchild");
    receipt(state, "root-invalid", { kind: "memory_validation", memoryDigest: root, contaminated: true, derivedFromDigests: [] });
    receipt(state, "grandchild-valid", { kind: "memory_validation", memoryDigest: grandchild, contaminated: false, derivedFromDigests: [child] });
    receipt(state, "child-valid", { kind: "memory_validation", memoryDigest: child, contaminated: false, derivedFromDigests: [root] });
    state.auditEvents = [memoryEvent(grandchild)];
    expect(compileVerdict(state).basis).toContainEqual(expect.objectContaining({ code: "REFLEX_TRANSITIVE_MEMORY_CONTAMINATION", evidenceIds: ["child-valid", "grandchild-valid", "root-invalid"] }));
    expect(compileVerdict(state).integrity).toBe("INVALID");
  });

  it("invalidates memory introduced during the amnesic first wave", () => {
    const state = input(); state.auditEvents = [memoryEvent(digest("memory"), "diverge")];
    expect(compileVerdict(state).basis).toContainEqual(expect.objectContaining({ code: "REFLEX_FIRST_WAVE_MEMORY_CONTAMINATION" }));
  });

  it.each(["preference_wording", "initial_condition"] as const)("requires executed matched pairs to detect %s sensitivity", (axis) => {
    const state = input();
    const pair = { kind: "paired_probe" as const, pairId: "pair", axis, obligationDigest: state.intentContractDigest, evidenceDigest: state.graph.digest() };
    receipt(state, "baseline", { ...pair, arm: "baseline", outcomeDigest: digest("accept") });
    expect(compileVerdict(state).judgment).toBe("ACCEPT");
    receipt(state, "variant", { ...pair, arm: "variant", outcomeDigest: digest("reject") });
    expect(compileVerdict(state).judgment).toBe("UNPROVEN");
    expect(evaluateInvestigationAudits(state).audits).toContainEqual(expect.objectContaining({ audit: axis, status: "failed" }));
  });

  it("does not compare paired outcomes with different obligations or evidence", () => {
    const state = input();
    receipt(state, "baseline", { kind: "paired_probe", pairId: "pair", axis: "preference_wording", arm: "baseline", obligationDigest: digest("obligation"), evidenceDigest: digest("before"), outcomeDigest: digest("accept") });
    receipt(state, "variant", { kind: "paired_probe", pairId: "pair", axis: "preference_wording", arm: "variant", obligationDigest: digest("obligation"), evidenceDigest: digest("after"), outcomeDigest: digest("reject") });
    expect(compileVerdict(state).judgment).toBe("ACCEPT");
    expect(evaluateInvestigationAudits(state).audits).toContainEqual(expect.objectContaining({ audit: "preference_wording", status: "unmeasured" }));
  });

  it("cannot upgrade a terminal claim by citing an execution for another claim", () => {
    const state = input();
    receipt(state, "terminal", { kind: "terminal_claim", claimId: "uncited-new-claim", evidenceIds: ["execution"] });
    expect(compileVerdict(state).judgment).toBe("UNPROVEN");
    const verdict = compileVerdict(state);
    const report = evaluateReflex(verdict, state, { loop: 1, canAcquireMaterialEvidence: false });
    expect(() => assertReflexComplete({ ...verdict, judgment: "ACCEPT" }, [report])).toThrow(/downgrade/);
  });

  it("rejects a model-sourced audit receipt even when its digest is correct", () => {
    const audit = lineage("a");
    const event = createCaseEvent({ caseDigest: digest("case"), runDigest: digest("run"), observedAt: "2026-09-05T00:00:00.000Z", stage: "diverge", kind: "evidence.observed", actor: { id: "mind", kind: "mind" }, payload: { evidenceId: "audit", evidenceType: "tool_observation", summary: "Claimed audit", contentDigest: digestJson(audit as unknown as JsonValue), audit } }, 1, null);
    expect(compileVerdict(projectEvents([event], { intentContract }).input)).toMatchObject({ integrity: "INVALID", judgment: "NOT_APPLICABLE" });
  });

  it("rejects wrong audit digests and unknown receipt fields before appending the event", () => {
    const audit = lineage("a");
    const draft = { caseDigest: digest("case"), runDigest: digest("run"), observedAt: "2026-09-05T00:00:00.000Z", stage: "diverge" as const, kind: "evidence.observed" as const, actor: { id: "bone", kind: "kernel" as const }, payload: { evidenceId: "audit", evidenceType: "tool_observation" as const, summary: "Runtime audit", contentDigest: digest("wrong"), audit } };
    expect(() => createCaseEvent(draft, 1, null)).toThrow(/digest/);
    const malformed = { ...audit, selfReportedIndependence: true };
    expect(() => createCaseEvent({ ...draft, payload: { ...draft.payload, contentDigest: digestJson(malformed as unknown as JsonValue), audit: malformed } }, 1, null)).toThrow(/not part of this protocol/);
  });

  it.each(["sandbox_failure", "provider_failure", "capability_loss"])("turns runtime %s into INVALID", (kind) => {
    const event = createCaseEvent({ caseDigest: digest("case"), runDigest: digest("run"), observedAt: "2026-09-05T00:00:00.000Z", stage: "self_scan", kind: "action.status", actor: { id: "bone", kind: "kernel" }, payload: { actionId: "failed", actionType: `integrity.${kind}`, status: "failed", summary: "A promised runtime capability failed." } }, 1, null);
    expect(compileVerdict(projectEvents([event], { intentContract }).input)).toMatchObject({ integrity: "INVALID", judgment: "NOT_APPLICABLE" });
  });
});
