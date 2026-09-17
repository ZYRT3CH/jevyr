import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { digestJson, type CaseEvent, type EvidencePayload } from "@jevyr/protocol";
import { EvidenceGraph, FileLedger, MemoryLedger, compileIntentContract, compileVerdict, createCaseEvent, projectEvents, verifyEventChain } from "../src/index.js";

const caseDigest = `sha256:${"1".repeat(64)}`;
const runDigest = `sha256:${"2".repeat(64)}`;
const intentContractDigest = digestJson({ intent: "policy-test" });
const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function stageDraft(summary: string) {
  return {
    caseDigest,
    runDigest,
    observedAt: "2026-09-04T12:00:00.000Z",
    stage: "cast" as const,
    kind: "stage.status" as const,
    actor: { id: "bone", kind: "kernel" as const },
    payload: { stage: "cast" as const, status: "working" as const, summary },
  };
}

describe("append-only event ledgers", () => {
  it("detects content and continuity tampering", () => {
    const first = createCaseEvent(stageDraft("received"), 1, null);
    const second = createCaseEvent(stageDraft("sealed copy"), 2, first.eventDigest);
    expect(verifyEventChain([first, second]).valid).toBe(true);
    const tampered = structuredClone(second) as CaseEvent<"stage.status">;
    tampered.payload.summary = "rewritten history";
    const result = verifyEventChain([first, tampered]);
    expect(result.valid).toBe(false);
    expect(result.problems.map((item) => item.code)).toContain("digest_mismatch");
  });

  it("rejects hidden reasoning fields from the public event stream", () => {
    expect(() => createCaseEvent({
      ...stageDraft("public status"),
      payload: { ...stageDraft("public status").payload, scratchpad: "private deliberation" } as never,
    }, 1, null)).toThrow(/hidden reasoning/);
  });

  it("snapshots and deeply freezes caller data before committing the digest", () => {
    const actor = { id: "bone", kind: "kernel" as const };
    const payload = { stage: "cast" as const, status: "working" as const, summary: "original" };
    const event = createCaseEvent({ ...stageDraft("ignored"), actor, payload }, 1, null);

    actor.id = "mutated-after-commit";
    payload.summary = "mutated-after-commit";

    expect(event.actor.id).toBe("bone");
    expect(event.payload.summary).toBe("original");
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.actor)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(verifyEventChain([event]).valid).toBe(true);
  });

  it("rejects active event fields without invoking their accessors", () => {
    let reads = 0;
    const payload = { stage: "cast", status: "working" } as Record<string, unknown>;
    Object.defineProperty(payload, "summary", {
      enumerable: true,
      get() {
        reads += 1;
        return "must not execute";
      },
    });

    expect(() => createCaseEvent({
      ...stageDraft("ignored"),
      payload: payload as never,
    }, 1, null)).toThrow(/accessor|canonical|property/iu);
    expect(reads).toBe(0);
  });

  it("verifies hostile event objects without executing their fields", () => {
    const valid = createCaseEvent(stageDraft("safe"), 1, null);
    let reads = 0;
    const hostile = structuredClone(valid) as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "payload", {
      enumerable: true,
      get() {
        reads += 1;
        return valid.payload;
      },
    });

    const verification = verifyEventChain([hostile as unknown as CaseEvent]);
    expect(verification.valid).toBe(false);
    expect(verification.problems.map((entry) => entry.code)).toContain("invalid_event_value");
    expect(reads).toBe(0);
  });

  it("serializes concurrent file appends and fsyncs valid JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevyr-ledger-"));
    temporary.push(directory);
    const path = join(directory, "blood.jsonl");
    const ledger = new FileLedger(path, caseDigest, runDigest);
    await Promise.all([ledger.append(stageDraft("one")), ledger.append(stageDraft("two")), ledger.append(stageDraft("three"))]);
    expect((await ledger.verify()).valid).toBe(true);
    expect((await ledger.read()).map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(3);
  });

  it("refuses malformed UTF-8 bytes in a durable ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevyr-ledger-utf8-"));
    temporary.push(directory);
    const path = join(directory, "blood.jsonl");
    await writeFile(path, Uint8Array.from([0xff, 0x0a]));
    const ledger = new FileLedger(path, caseDigest, runDigest);
    await expect(ledger.read()).rejects.toThrow(/encoded data|UTF-8/iu);
  });

  it("refuses duplicate event keys even when last-key parsing would preserve the hash chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevyr-ledger-duplicate-key-"));
    temporary.push(directory);
    const path = join(directory, "blood.jsonl");
    const event = createCaseEvent(stageDraft("ambiguous bytes"), 1, null);
    const ambiguous = JSON.stringify(event).replace('"sequence":1', '"sequence":99,"sequence":1');
    await writeFile(path, `${ambiguous}\n`, "utf8");
    const ledger = new FileLedger(path, caseDigest, runDigest);
    await expect(ledger.read()).rejects.toThrow(/duplicate object key "sequence"/u);
  });

  it("refuses cross-case appends", async () => {
    const ledger = new MemoryLedger(caseDigest, runDigest);
    await expect(ledger.append({ ...stageDraft("wrong"), caseDigest: `sha256:${"9".repeat(64)}` })).rejects.toThrow(/different sealed case/);
  });
});

function baseGraph(authority: "model_report" | "peer_report" | "artifact_inspection" | "deterministic_tool" | "subject_snapshot" | "memory_hint" | "sandbox_execution", edgeKind: "supports" | "refutes" = "supports"): EvidenceGraph {
  const graph = new EvidenceGraph();
  graph.addNode({ id: "must_hold", kind: "claim", authority: "model_report", summary: "The invariant holds", contentDigest: digestJson({ text: "invariant" }) });
  graph.addNode({ id: "observed", kind: "observation", authority, summary: "Observation", contentDigest: digestJson({ result: true }) });
  graph.addEdge({ id: `observed:${edgeKind}:must_hold`, from: "observed", to: "must_hold", kind: edgeKind });
  return graph;
}

const candidate = { id: "candidate-a", feasibility: "BUILDABLE_NOW" as const, survived: true, selected: true, embodiment: "built" as const };
const assay = { id: "assay-a", status: "passed" as const, critical: true, evidenceIds: ["observed"], obligationId: "must_hold", candidateId: "candidate-a" };

describe("deterministic policy", () => {
  it("does not let model self-report prove a critical obligation", () => {
    const verdict = compileVerdict({ intentContractDigest, graph: baseGraph("model_report"), obligations: [{ id: "must_hold", statement: "The invariant holds", critical: true }], candidates: [candidate], assays: [assay] });
    expect(verdict.judgment).toBe("UNPROVEN");
    expect(verdict.basis.some((entry) => entry.code === "MISSING_EVIDENCE")).toBe(true);
  });

  it("accepts only with sandbox execution evidence and a passed critical assay", () => {
    const input = { intentContractDigest, graph: baseGraph("sandbox_execution"), obligations: [{ id: "must_hold", statement: "The invariant holds", critical: true }], candidates: [candidate], assays: [assay] };
    const first = compileVerdict(input);
    const second = compileVerdict(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ integrity: "VALID", creation: "CONCEIVED", embodiment: "BUILT", judgment: "ACCEPT" });
  });

  it("rejects a decisive counterexample", () => {
    const verdict = compileVerdict({ intentContractDigest, graph: baseGraph("sandbox_execution", "refutes"), obligations: [{ id: "must_hold", statement: "The invariant holds", critical: true }], candidates: [candidate], assays: [assay] });
    expect(verdict.judgment).toBe("REJECT");
  });

  it("gives no support or refutation authority to evidence without a typed sandbox substrate", () => {
    for (const authority of ["model_report", "peer_report", "artifact_inspection", "deterministic_tool", "subject_snapshot", "memory_hint"] as const) {
      const support = compileVerdict({ intentContractDigest, graph: baseGraph(authority), obligations: [{ id: "must_hold", statement: "The invariant holds", critical: true }], candidates: [candidate], assays: [assay] });
      const refutation = compileVerdict({ intentContractDigest, graph: baseGraph(authority, "refutes"), obligations: [{ id: "must_hold", statement: "The invariant holds", critical: true }], candidates: [candidate], assays: [assay] });
      expect(support.judgment, authority).toBe("UNPROVEN");
      expect(refutation.judgment, authority).toBe("UNPROVEN");
    }
  });

  it("marks invalid-before-judgment as the sole not-applicable path", () => {
    const verdict = compileVerdict({ intentContractDigest, graph: baseGraph("sandbox_execution"), obligations: [{ id: "must_hold", statement: "The invariant holds", critical: true }], candidates: [candidate], assays: [assay], integrityIssues: [{ code: "LEDGER", summary: "Ledger broken", severity: "fatal", phase: "pre_judgment" }] });
    expect(verdict.integrity).toBe("INVALID");
    expect(verdict.judgment).toBe("NOT_APPLICABLE");
  });
});

describe("event-projection evidence authority", () => {
  const unverifiedTypes: readonly EvidencePayload["evidenceType"][] = [
    "tool_observation",
    "artifact",
    "subject_snapshot",
    "model_report",
    "peer_report",
    "memory_hint",
  ];

  function evidenceEvent(
    evidenceType: EvidencePayload["evidenceType"],
    obligationId: string,
  ): CaseEvent<"evidence.observed"> {
    return createCaseEvent({
      caseDigest,
      runDigest,
      observedAt: "2026-09-04T12:00:00.000Z",
      stage: "assay",
      kind: "evidence.observed",
      actor: { id: "claimed-observer", kind: "tool" },
      payload: {
        evidenceId: `evidence-${evidenceType}`,
        evidenceType,
        summary: "A public fact with an unverified verdict label.",
        contentDigest: digestJson({ evidenceType }),
        supports: [obligationId],
      },
    }, 1, null);
  }

  it("preserves non-sandbox facts but strips every claimed verdict edge", () => {
    const contract = compileIntentContract({ impulse: "Return valid JSON." });
    const obligationId = contract.criticalObligations[0]?.id;
    if (obligationId === undefined) throw new Error("fixture lacks an obligation");
    for (const evidenceType of unverifiedTypes) {
      const event = evidenceEvent(evidenceType, obligationId);
      const projection = projectEvents([event], { intentContract: contract });
      expect(projection.graph.node(event.payload.evidenceId), evidenceType).toBeDefined();
      expect(projection.graph.incoming(obligationId, "supports"), evidenceType).toEqual([]);
      expect(projection.input.integrityIssues, evidenceType).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "UNVERIFIED_EVIDENCE_EDGE", severity: "fatal" }),
      ]));
    }
  });

  it("does not trust a sandbox_execution label without an exact verified tuple", () => {
    const contract = compileIntentContract({ impulse: "Return valid JSON." });
    const obligationId = contract.criticalObligations[0]?.id;
    if (obligationId === undefined) throw new Error("fixture lacks an obligation");
    const event = evidenceEvent("sandbox_execution", obligationId);
    const unverified = projectEvents([event], { intentContract: contract });
    expect(unverified.graph.incoming(obligationId, "supports")).toEqual([]);
    expect(unverified.input.integrityIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNVERIFIED_EVIDENCE_EDGE", severity: "fatal" }),
    ]));

    const verified = projectEvents([event], {
      intentContract: contract,
      verifiedEvidenceEdges: [{
        eventDigest: event.eventDigest,
        evidenceId: event.payload.evidenceId,
        contentDigest: event.payload.contentDigest,
        targetId: obligationId,
        kind: "supports",
      }],
    });
    expect(verified.graph.incoming(obligationId, "supports")).toHaveLength(1);
    expect(verified.input.integrityIssues ?? []).toEqual([]);
  });

  it("rejects a verified tuple that is not consumed by the exact public edge", () => {
    const contract = compileIntentContract({ impulse: "Return valid JSON." });
    const obligationId = contract.criticalObligations[0]?.id;
    if (obligationId === undefined) throw new Error("fixture lacks an obligation");
    const event = evidenceEvent("sandbox_execution", obligationId);
    const projection = projectEvents([event], {
      intentContract: contract,
      verifiedEvidenceEdges: [{
        eventDigest: event.eventDigest,
        evidenceId: event.payload.evidenceId,
        contentDigest: digestJson({ substituted: true }),
        targetId: obligationId,
        kind: "supports",
      }],
    });
    expect(projection.graph.incoming(obligationId, "supports")).toEqual([]);
    expect(projection.input.integrityIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNVERIFIED_EVIDENCE_EDGE" }),
      expect.objectContaining({ code: "UNUSED_VERIFIED_EVIDENCE_EDGE" }),
    ]));
  });
});
