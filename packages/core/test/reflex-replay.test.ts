import { describe, expect, it } from "vitest";
import { createSearchEnvelope, digestJson, type CaseEvent, type EventKind, type SealedCase } from "@jevyr/protocol";
import { assertReflexComplete, compileIntentContract, compileVerdict, createCaseEvent, crystallizeRecord, evaluateReflex, projectEvents, replayCase, type EventDraft, type VerifiedEvidenceEdge } from "../src/index.js";

const caseDigest = `sha256:${"a".repeat(64)}`;
const runDigest = `sha256:${"b".repeat(64)}`;
const actor = { id: "inner-1", kind: "mind" as const };
const intentContract = compileIntentContract({ impulse: "`node artifact.js` exits with code 0." });
const obligationId = intentContract.criticalObligations[0]?.id ?? "missing-obligation";
const sealed: SealedCase = {
  protocol: "jevyr.case/1",
  caseId: "case_replay_12345678",
  submissionDigest: `sha256:${"0".repeat(64)}`,
  subjectMaterialCaptureDigest: `sha256:${"9".repeat(64)}`,
  caseDigest,
  runDigest,
  sealedAt: "2026-09-04T11:59:00.000Z",
  policyVersion: "jevyr.bone/1",
  policyDigest: `sha256:${"c".repeat(64)}`,
  genomeVersion: "jevyr.genome/1",
  genomeDigest: `sha256:${"d".repeat(64)}`,
  searchEnvelope: createSearchEnvelope({
    attemptSafetyCeiling: "1500000000000000000000",
    nursery: { minimumAttempts: 1, saturationWindow: 1, independentLineages: 1, challengeInterval: 1 },
    resources: {
      maxMindInvocations: 1, maxInputTokens: 1, maxOutputTokens: 1, maxWallMillis: 1,
      maxSingleInvocationMillis: 1, maxGeneratedBytes: 1, maxForgeCpuMillis: 0,
      maxForgeWallMillis: 0, maxMemorySeconds: 0, maxWritableBytes: 0,
      maxWritableInodes: 0, maxArtifactBytes: 0, maxNetworkBytes: 0,
      concurrentLineages: 1, maxTotalAssayCost: 0,
    },
    seedDerivation: "sha256-run-digest-frontier-v1",
  }),
  intentContractDigest: intentContract.digest,
  intentContract,
  intent: { impulse: intentContract.goal.statement, mode: "audit", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control: "sovereign", seed: "fixed" },
  subjects: [],
};

function append<K extends EventKind>(events: CaseEvent[], draft: Omit<EventDraft<K>, "caseDigest" | "runDigest" | "observedAt">): void {
  events.push(createCaseEvent({
    ...draft,
    caseDigest,
    runDigest,
    observedAt: `2026-09-04T12:00:${String(events.length).padStart(2, "0")}.000Z`,
  } as EventDraft<K>, events.length + 1, events.at(-1)?.eventDigest ?? null));
}

function completeEvents(): CaseEvent[] {
  const events: CaseEvent[] = [];
  append(events, { stage: "interpret", kind: "claim.published", actor, payload: { claimId: obligationId, statement: intentContract.goal.statement, claimType: "requirement" } });
  append(events, { stage: "diverge", kind: "candidate.status", actor, payload: { candidateId: "candidate-1", status: "proposed", summary: "A strange but testable mechanism", feasibility: "BUILDABLE_NOW" } });
  append(events, { stage: "recombine", kind: "candidate.status", actor, payload: { candidateId: "candidate-1", status: "selected", summary: "Selected by quality-diversity policy", feasibility: "BUILDABLE_NOW" } });
  append(events, { stage: "embody", kind: "candidate.status", actor: { id: "forge", kind: "forge" }, payload: { candidateId: "candidate-1", status: "embodied", summary: "Built in disposable overlay", artifactDigests: [digestJson({ artifact: 1 })] } });
  append(events, { stage: "assay", kind: "evidence.observed", actor: { id: "runner", kind: "tool" }, payload: { evidenceId: "execution-1", evidenceType: "sandbox_execution", summary: "Artifact executed and met the sealed oracle", contentDigest: digestJson({ exitCode: 0 }), supports: [obligationId] } });
  append(events, { stage: "assay", kind: "assay.status", actor: { id: "bone", kind: "kernel" }, payload: { assayId: "assay-1", candidateId: "candidate-1", obligationId, status: "passed", critical: true, summary: "Executable oracle passed", evidenceIds: ["execution-1"] } });
  return events;
}

function verifiedEdges(events: readonly CaseEvent[]): readonly VerifiedEvidenceEdge[] {
  return events.flatMap((event) => {
    if (event.kind !== "evidence.observed" || event.payload.evidenceType !== "sandbox_execution") return [];
    return [
      ...(event.payload.supports ?? []).map((targetId) => ({
        eventDigest: event.eventDigest,
        evidenceId: event.payload.evidenceId,
        contentDigest: event.payload.contentDigest,
        targetId,
        kind: "supports" as const,
      })),
      ...(event.payload.refutes ?? []).map((targetId) => ({
        eventDigest: event.eventDigest,
        evidenceId: event.payload.evidenceId,
        contentDigest: event.payload.contentDigest,
        targetId,
        kind: "refutes" as const,
      })),
    ];
  });
}

describe("Reflex and replay", () => {
  it("refuses to crystallize a verdict without Reflex", () => {
    const events = completeEvents();
    const projection = projectEvents(events, { intentContract, verifiedEvidenceEdges: verifiedEdges(events) });
    const verdict = compileVerdict(projection.input);
    expect(() => assertReflexComplete(verdict, [])).toThrow(/mandatory Reflex/);
  });

  it("replays the same public evidence into the same verdict", () => {
    const events = completeEvents();
    const authority = verifiedEdges(events);
    const projection = projectEvents(events, { intentContract, verifiedEvidenceEdges: authority });
    const provisional = compileVerdict(projection.input);
    const reflex = evaluateReflex(provisional, projection.input, { loop: 1, canAcquireMaterialEvidence: false });
    append(events, { stage: "reflex", kind: "reflex.completed", actor: { id: "reflex", kind: "kernel" }, payload: reflex });

    const first = replayCase(events, { intentContract, verifiedEvidenceEdges: authority });
    const second = replayCase(structuredClone(events), { intentContract, verifiedEvidenceEdges: authority });
    expect(first.verdict).toEqual(second.verdict);
    expect(first.eventHeadDigest).toBe(second.eventHeadDigest);
    expect(first.crystallizable).toBe(true);
    expect(first.verdict).toMatchObject({ judgment: "ACCEPT", integrity: "VALID", creation: "CONCEIVED", embodiment: "BUILT" });
    expect(first.reflex.decision).toBe("confirm");

    const record = crystallizeRecord({
      sealed,
      eventHeadDigest: first.eventHeadDigest,
      verdict: first.verdict,
      reflexReports: first.reflexReports,
      memoryInfluences: first.memoryInfluences,
      crystallizedAt: "2026-09-04T12:01:00.000Z",
    });
    expect(record).toMatchObject({
      policyDigest: sealed.policyDigest,
      genomeDigest: sealed.genomeDigest,
      searchDigest: sealed.searchEnvelope.digest,
    });
  });

  it("diagnoses a corrupted replay as INVALID without treating it as a new judgment", () => {
    const events = completeEvents();
    const authority = verifiedEdges(events);
    const projection = projectEvents(events, { intentContract, verifiedEvidenceEdges: authority });
    const provisional = compileVerdict(projection.input);
    append(events, { stage: "reflex", kind: "reflex.completed", actor: { id: "reflex", kind: "kernel" }, payload: evaluateReflex(provisional, projection.input, { loop: 1, canAcquireMaterialEvidence: false }) });
    const tampered = structuredClone(events);
    const evidence = tampered.find((event) => event.kind === "evidence.observed") as CaseEvent<"evidence.observed">;
    evidence.payload.summary = "tampered after signing";
    const replay = replayCase(tampered, { intentContract, verifiedEvidenceEdges: authority });
    expect(replay.verdict.integrity).toBe("INVALID");
    expect(replay.verdict.judgment).toBe("NOT_APPLICABLE");
    expect(replay.crystallizable).toBe(false);
  });

  it("caps Reflex at one material retry", () => {
    const events = completeEvents();
    const projection = projectEvents(events, { intentContract, verifiedEvidenceEdges: verifiedEdges(events) });
    const verdict = compileVerdict(projection.input);
    const first = { ...evaluateReflex(verdict, projection.input, { loop: 1, canAcquireMaterialEvidence: true }), decision: "repeat_once" as const };
    const second = { ...evaluateReflex(verdict, projection.input, { loop: 2, canAcquireMaterialEvidence: true }), decision: "revise" as const };
    expect(assertReflexComplete(verdict, [first, second])).toEqual(second);
    expect(() => assertReflexComplete(verdict, [first, second, second])).toThrow(/hard-capped/);
  });

  it("replays the deliberately unverified first Reflex view before its independent authority replay", () => {
    const events = completeEvents();
    const authority = verifiedEdges(events);
    const before = projectEvents(events, { intentContract, verifiedEvidenceEdges: [] });
    const first = evaluateReflex(compileVerdict(before.input), before.input, { loop: 1, canAcquireMaterialEvidence: true });
    expect(first.decision).toBe("repeat_once");
    append(events, { stage: "reflex", kind: "reflex.completed", actor: { id: "reflex", kind: "kernel" }, payload: first });
    const after = projectEvents(events, { intentContract, verifiedEvidenceEdges: authority });
    const second = evaluateReflex(compileVerdict(after.input), after.input, { loop: 2, canAcquireMaterialEvidence: false });
    append(events, { stage: "reflex", kind: "reflex.completed", actor: { id: "reflex", kind: "kernel" }, payload: second });
    expect(replayCase(events, { intentContract, verifiedEvidenceEdges: authority })).toMatchObject({ crystallizable: true, verdict: { integrity: "VALID", judgment: "ACCEPT" } });
  });

  it("detects a rewritten audit report even when its event chain is freshly hashed", () => {
    const events = completeEvents();
    const authority = verifiedEdges(events);
    const projection = projectEvents(events, { intentContract, verifiedEvidenceEdges: authority });
    const report = evaluateReflex(compileVerdict(projection.input), projection.input, { loop: 1, canAcquireMaterialEvidence: false });
    append(events, { stage: "reflex", kind: "reflex.completed", actor: { id: "reflex", kind: "kernel" }, payload: { ...report, audits: report.audits?.map((audit) => ({ ...audit, status: "passed" })) } });
    const replay = replayCase(events, { intentContract, verifiedEvidenceEdges: authority });
    expect(replay.verdict.integrity).toBe("INVALID");
    expect(replay.verdict.basis).toContainEqual(expect.objectContaining({ code: "INTEGRITY_REFLEX_REPORT_MISMATCH" }));
  });
});
