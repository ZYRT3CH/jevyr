import { describe, expect, it } from "vitest";
import { digestJson } from "@jevyr/protocol";
import { assertPolicyParity, compileVerdict, EvidenceGraph, JEVYR_BONE_DESCRIPTOR, REGO_POLICY_SOURCE_DIGEST, REGO_POLICY_WASM_DIGEST, type AssayAssessment, type CandidateAssessment, type IntegrityIssue, type PolicyInput } from "../src/index.js";

describe("OPA compiled Wasm constitutional policy", () => {
  it("binds the installed source and compiled module into Bone identity", () => {
    expect(JEVYR_BONE_DESCRIPTOR.policyKernel).toMatchObject({ engine: "opa-wasm", sourceDigest: REGO_POLICY_SOURCE_DIGEST, wasmDigest: REGO_POLICY_WASM_DIGEST, typescriptParity: "mandatory-fail-closed" });
  });

  it("matches the reference across evidence, candidate, assay, and integrity boundaries", () => {
    let evaluated = 0;
    const observedJudgments = new Set<string>();
    const observedCreation = new Set<string>();
    const observedEmbodiment = new Set<string>();
    for (const authority of ["model_report", "sandbox_execution"] as const) {
      for (const edge of ["supports", "refutes", "both"] as const) {
        for (const assayStatus of ["passed", "failed", "blocked"] as const) {
          for (const candidateKind of ["built", "not_built", "failed", "contradicted", "none", "duplicate"] as const) {
            for (const fatalPhase of ["none", "pre_judgment", "post_judgment"] as const) {
              const graph = new EvidenceGraph();
              graph.addNode({ id: "critical", kind: "claim", authority: "model_report", summary: "Executable property.", contentDigest: digestJson({ claim: 1 }) });
              graph.addNode({ id: "observation", kind: "observation", authority, summary: "Assay observation.", contentDigest: digestJson({ observed: 1 }) });
              if (edge === "supports" || edge === "both") graph.addEdge({ id: "support", from: "observation", to: "critical", kind: "supports" });
              if (edge === "refutes" || edge === "both") graph.addEdge({ id: "refute", from: "observation", to: "critical", kind: "refutes" });
              const candidate: CandidateAssessment = { id: "a", feasibility: candidateKind === "contradicted" ? "CONTRADICTED" : "BUILDABLE_NOW", selected: true, survived: candidateKind !== "contradicted", embodiment: candidateKind === "not_built" || candidateKind === "failed" ? candidateKind : "built" };
              const candidates = candidateKind === "none" ? [] : candidateKind === "duplicate" ? [candidate, { ...candidate, id: "b" }] : [candidate];
              const assays: AssayAssessment[] = [{ id: "assay", critical: true, status: assayStatus, evidenceIds: ["observation"], obligationId: "critical" }];
              const integrityIssues: IntegrityIssue[] = fatalPhase === "none" ? [] : [{ code: "FAILURE", summary: "Observed failure.", severity: "fatal", phase: fatalPhase }];
              const state: PolicyInput = { graph, candidates, assays, integrityIssues, obligations: [{ id: "critical", critical: true, statement: "Executable property." }], intentContractDigest: digestJson({ intent: 1 }) };
              // compileVerdict always evaluates both implementations and fails
              // closed on any disagreement; this exercises 324 distinct inputs.
              const verdict = compileVerdict(state);
              expect(compileVerdict({ ...state, candidates: [...candidates].reverse() })).toEqual(verdict);
              observedJudgments.add(verdict.judgment); observedCreation.add(verdict.creation); observedEmbodiment.add(verdict.embodiment);
              evaluated += 1;
            }
          }
        }
      }
    }
    expect(evaluated).toBe(324);
    expect([...observedJudgments].sort()).toEqual(["ACCEPT", "NOT_APPLICABLE", "REJECT", "UNPROVEN"]);
    expect([...observedCreation].sort()).toEqual(["CONCEIVED", "FAILED", "NO_SURVIVOR"]);
    expect([...observedEmbodiment].sort()).toEqual(["BUILT", "FAILED", "NOT_BUILT"]);
  });

  it("fails closed on a disagreement rather than falling back to TypeScript", () => {
    expect(() => assertPolicyParity({ integrity: "VALID", creation: "CONCEIVED", embodiment: "BUILT", judgment: "ACCEPT" }, { integrity: "VALID", creation: "CONCEIVED", embodiment: "BUILT", judgment: "UNPROVEN" })).toThrow(/parity failure on judgment/);
  });
});
