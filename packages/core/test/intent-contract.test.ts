import { describe, expect, it } from "vitest";
import { digestJson, sha256Digest, type CaseEvent, type EventKind } from "@jevyr/protocol";
import {
  EvidenceGraph,
  assertIntentContract,
  assertReflexComplete,
  bindIntentContract,
  compileIntentContract,
  compileVerdict,
  createCaseEvent,
  evaluateReflex,
  projectEvents,
  replayCase,
  type EventDraft,
  type IntentContract,
  type VerifiedEvidenceEdge,
} from "../src/index.js";

const caseDigest = `sha256:${"c".repeat(64)}`;
const runDigest = `sha256:${"d".repeat(64)}`;

function append<K extends EventKind>(events: CaseEvent[], draft: Omit<EventDraft<K>, "caseDigest" | "runDigest" | "observedAt">): void {
  events.push(createCaseEvent({
    ...draft,
    caseDigest,
    runDigest,
    observedAt: `2026-09-04T13:00:${String(events.length).padStart(2, "0")}.000Z`,
  } as EventDraft<K>, events.length + 1, events.at(-1)?.eventDigest ?? null));
}

describe("deterministic intent compiler", () => {
  it("preserves the exact impulse, canonicalizes unordered declarations, and deeply freezes the result", () => {
    const input = {
      impulse: "  Return valid JSON without network access.  ",
      constraints: ["read-only", "offline", "read-only"],
      requestedAssays: ["pnpm test", "JSON parse"],
      subjectIds: ["repo", "spec", "repo"],
    };
    const first = compileIntentContract(input);
    const second = compileIntentContract({
      ...input,
      constraints: ["offline", "read-only"],
      requestedAssays: ["JSON parse", "pnpm test"],
      subjectIds: ["spec", "repo"],
    });

    expect(first.digest).toBe(second.digest);
    expect(first.originalImpulse).toBe(input.impulse);
    expect(first.originalImpulseDigest).toBe(sha256Digest(input.impulse));
    expect(first.subjectIds).toEqual(["repo", "spec"]);
    expect(first.criticalObligations.every((entry) => entry.assayability === "ASSAYABLE")).toBe(true);
    expect(first.criticalObligations.some((entry) => entry.oracle?.kind === "network_access_count")).toBe(true);
    expect(first.criticalObligations.some((entry) => entry.oracle?.kind === "output_parse")).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.criticalObligations)).toBe(true);
    expect(Object.isFrozen(first.criticalObligations[0]?.oracle)).toBe(true);
  });

  it("leaves subjective and deictic meaning unresolved instead of manufacturing an oracle", () => {
    const contract = compileIntentContract({ impulse: "Make this extraordinarily beautiful and better." });
    expect(contract.ambiguities.map((entry) => entry.code)).toEqual(["DEICTIC_REFERENCE", "SUBJECTIVE_PREDICATE"]);
    expect(contract.alternativeInterpretations.length).toBeGreaterThanOrEqual(4);
    expect(contract.alternativeInterpretations.every((entry) => entry.resolution === "UNRESOLVED")).toBe(true);
    expect(contract.criticalObligations[0]).toMatchObject({ assayability: "UNASSAYABLE" });
    expect(contract.criticalObligations[0]?.oracle).toBeUndefined();
  });

  it("extracts explicit success and failure clauses without selecting an interpretation", () => {
    const contract = compileIntentContract({
      impulse: "Build the artifact; success means `pnpm test` exits with code 0; failure means the repository changes.",
    });
    expect(contract.goal).toEqual({ statement: "Build the artifact", source: "impulse_prefix" });
    expect(contract.successConditions.some((entry) => entry.source === "impulse" && entry.statement === "`pnpm test` exits with code 0")).toBe(true);
    expect(contract.failureConditions.some((entry) => entry.source === "impulse" && entry.statement === "the repository changes")).toBe(true);
    expect(contract.criticalObligations.some((entry) => entry.oracle?.kind === "command_exit_code" && entry.oracle.operand === "pnpm test")).toBe(true);
  });

  it("detects post-compilation mutation through the canonical digest", () => {
    const contract = structuredClone(compileIntentContract({ impulse: "Return valid JSON." })) as IntentContract;
    (contract.goal as { statement: string }).statement = "Return XML";
    expect(() => assertIntentContract(contract)).toThrow(/digest mismatch/);
  });

  it.each([
    ["`node jevyr.experiment.mjs` exits with code 0", "command_exit_code", "node jevyr.experiment.mjs"],
    ["returns exactly 3.14", "exact_output", "result"],
    ['returns exactly "https://example.org/path?q=1;v=2"', "exact_output", "result"],
    ['returns exactly "passed. really!"', "exact_output", "result"],
  ])("preserves punctuation inside declared oracle operands: %s", (statement, kind, operand) => {
    const contract = compileIntentContract({ impulse: `Build the artifact. Success means ${statement}. Failure means it crashes.` });
    expect(contract.successConditions).toContainEqual(expect.objectContaining({ source: "impulse", statement }));
    expect(contract.criticalObligations).toContainEqual(expect.objectContaining({ statement, oracle: expect.objectContaining({ kind, operand }) }));
    expect(contract.failureConditions).toContainEqual(expect.objectContaining({ source: "impulse", statement: "it crashes" }));
  });
});

describe("intent-bound policy and replay", () => {
  it("forces UNPROVEN when a critical statement has no truth-conditional oracle", () => {
    const contract = compileIntentContract({ impulse: "Create something beautiful." });
    const input = bindIntentContract({
      graph: new EvidenceGraph(),
      candidates: [{ id: "candidate", feasibility: "BUILDABLE_NOW", survived: true, selected: true, embodiment: "built" }],
      assays: [],
    }, contract);
    const verdict = compileVerdict(input);
    const reflex = evaluateReflex(verdict, input, { loop: 1, canAcquireMaterialEvidence: true });

    expect(verdict.intentContractDigest).toBe(contract.digest);
    expect(verdict.judgment).toBe("UNPROVEN");
    expect(verdict.basis.some((entry) => entry.code === "UNASSAYABLE_OBLIGATION")).toBe(true);
    expect(reflex.intentContractDigest).toBe(contract.digest);
    expect(reflex.decision).toBe("revise");
    expect(reflex.materialFindings.some((entry) => entry.code === "UNASSAYABLE_OBLIGATION")).toBe(true);
    expect(() => assertReflexComplete(verdict, [{ ...reflex, intentContractDigest: `sha256:${"e".repeat(64)}` }])).toThrow(/different intent contract/);
  });

  it("replays evidence against the same immutable contract and binds the verdict and Reflex", () => {
    const contract = compileIntentContract({ impulse: "Return valid JSON." });
    const obligationId = contract.criticalObligations[0]?.id;
    if (!obligationId) throw new Error("test contract lacks an obligation");
    const events: CaseEvent[] = [];
    append(events, { stage: "diverge", kind: "candidate.status", actor: { id: "mind", kind: "mind" }, payload: { candidateId: "candidate", status: "proposed", summary: "JSON emitter", feasibility: "BUILDABLE_NOW" } });
    append(events, { stage: "recombine", kind: "candidate.status", actor: { id: "bone", kind: "kernel" }, payload: { candidateId: "candidate", status: "selected", summary: "Selected", feasibility: "BUILDABLE_NOW" } });
    append(events, { stage: "embody", kind: "candidate.status", actor: { id: "forge", kind: "forge" }, payload: { candidateId: "candidate", status: "embodied", summary: "Built", artifactDigests: [digestJson({ artifact: "json-emitter" })] } });
    append(events, { stage: "assay", kind: "evidence.observed", actor: { id: "forge", kind: "forge" }, payload: { evidenceId: "json-parse", evidenceType: "sandbox_execution", summary: "Output parsed as JSON", contentDigest: digestJson({ parsed: true }), supports: [obligationId] } });
    append(events, { stage: "assay", kind: "assay.status", actor: { id: "bone", kind: "kernel" }, payload: { assayId: "assay-json", candidateId: "candidate", obligationId, status: "passed", critical: true, summary: "JSON oracle passed", evidenceIds: ["json-parse"] } });

    const observed = events.find((event) => event.kind === "evidence.observed") as CaseEvent<"evidence.observed">;
    const verifiedEvidenceEdges: readonly VerifiedEvidenceEdge[] = [{
      eventDigest: observed.eventDigest,
      evidenceId: observed.payload.evidenceId,
      contentDigest: observed.payload.contentDigest,
      targetId: obligationId,
      kind: "supports",
    }];
    const projection = projectEvents(events, { intentContract: contract, verifiedEvidenceEdges });
    const provisional = compileVerdict(projection.input);
    append(events, { stage: "reflex", kind: "reflex.completed", actor: { id: "reflex", kind: "kernel" }, payload: evaluateReflex(provisional, projection.input, { loop: 1, canAcquireMaterialEvidence: false }) });
    const replay = replayCase(events, { intentContract: contract, verifiedEvidenceEdges });

    expect(replay.verdict).toMatchObject({ judgment: "ACCEPT", intentContractDigest: contract.digest });
    expect(replay.reflex.intentContractDigest).toBe(contract.digest);
    expect(replay.crystallizable).toBe(true);
  });

  it("invalidates a requirement invented after Seal instead of enlarging the contract", () => {
    const contract = compileIntentContract({ impulse: "Return valid JSON." });
    const events: CaseEvent[] = [];
    append(events, {
      stage: "embody",
      kind: "claim.published",
      actor: { id: "late-planner", kind: "tool" },
      payload: {
        claimId: "obligation_invented_after_seal",
        statement: "A later component would prefer a green benchmark.",
        claimType: "requirement",
      },
    });

    const projection = projectEvents(events, { intentContract: contract });
    const verdict = compileVerdict(projection.input);
    expect(projection.input.obligations.map((entry) => entry.id)).toEqual(
      contract.criticalObligations.map((entry) => entry.id),
    );
    expect(verdict.integrity).toBe("INVALID");
    expect(verdict.judgment).toBe("NOT_APPLICABLE");
    expect(verdict.basis.some((entry) => entry.code === "INTEGRITY_UNSEALED_OBLIGATION")).toBe(true);
  });
});
