import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256Digest } from "@jevyr/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  TemporalDeep,
  type MemoryCandidate,
  type MemoryEvidenceObservation,
} from "../src/index.js";

const opened: TemporalDeep[] = [];
const temporaryRoots: string[] = [];
const originCase = sha256Digest("origin-case");
const caseA = sha256Digest("independent-case-a");
const caseB = sha256Digest("independent-case-b");
const caseC = sha256Digest("independent-case-c");
const stagedAt = "2026-09-04T10:00:00.000Z";

afterEach(async () => {
  while (opened.length > 0) opened.pop()?.close();
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    protocol: "jevyr.memory/1",
    scope: "PROJECT",
    kind: "strategy",
    abstractSummary: "Challenge the causal boundary before trusting the artifact.",
    content: { strategyFingerprint: "causal-boundary-challenge" },
    sourceMemoryDigests: [],
    evidenceDigests: [sha256Digest("origin-record")],
    projectId: "project-evidence-ledger",
    caseDigest: originCase,
    ...overrides,
  };
}

function deep(path = ":memory:") {
  const value = new TemporalDeep(path);
  opened.push(value);
  return value;
}

function reproduction(
  observationId: string,
  sourceCaseDigest: string,
  evidence: string,
): MemoryEvidenceObservation {
  return {
    protocol: "jevyr.memory-evidence-observation/1",
    observationId,
    kind: "REPRODUCTION",
    sourceCaseDigest,
    evidenceDigest: sha256Digest(evidence),
    observedAt: "2026-09-05T10:00:00.000Z",
  };
}

function review(
  observationId: string,
  kind: "CONTAMINATION" | "PRIVACY_REVIEW",
  sourceCaseDigest: string,
  evidence: string,
  passed: boolean,
): MemoryEvidenceObservation {
  return {
    protocol: "jevyr.memory-evidence-observation/1",
    observationId,
    kind,
    sourceCaseDigest,
    evidenceDigest: sha256Digest(evidence),
    observedAt: "2026-09-07T10:00:00.000Z",
    passed,
  };
}

function appendPassingBasis(store: TemporalDeep, memoryDigest: string) {
  store.appendEvidenceObservation(
    memoryDigest,
    reproduction("reproduction-a", caseA, "reproduction-evidence-a"),
  );
  store.appendEvidenceObservation(
    memoryDigest,
    reproduction("reproduction-b", caseB, "reproduction-evidence-b"),
  );
  store.appendEvidenceObservation(
    memoryDigest,
    review("contamination-pass", "CONTAMINATION", caseC, "contamination-evidence", true),
  );
}

describe("append-only reproduction evidence", () => {
  it("refuses evidence from the memory's origin Case", () => {
    const store = deep();
    const memory = store.stage(candidate(), stagedAt);
    expect(() =>
      store.appendEvidenceObservation(
        memory.digest,
        reproduction("origin-reproduction", originCase, "origin-self-claim"),
      ),
    ).toThrow(/origin Case/);
    expect(store.evidenceHistory(memory.digest)).toEqual([]);
  });

  it("refuses evidence that does not occur after the durable staging instant", () => {
    const store = deep();
    const memory = store.stage(candidate(), stagedAt);
    for (const observedAt of (
      ["2026-09-03T10:00:00.000Z", stagedAt] as const
    )) {
      expect(() =>
        store.appendEvidenceObservation(memory.digest, {
          ...reproduction(`non-later-${observedAt}`, caseA, `non-later-${observedAt}`),
          observedAt,
        }),
      ).toThrow(/after the memory was staged/);
    }
    expect(store.evidenceHistory(memory.digest)).toEqual([]);
  });

  it("rejects duplicate and conflicting observation identities", () => {
    const store = deep();
    const memory = store.stage(candidate(), stagedAt);
    const first = reproduction("stable-id", caseA, "first-evidence");
    store.appendEvidenceObservation(memory.digest, first);

    expect(() => store.appendEvidenceObservation(memory.digest, first)).toThrow(
      /Duplicate evidence observation identity/,
    );
    expect(() =>
      store.appendEvidenceObservation(
        memory.digest,
        reproduction("stable-id", caseA, "changed-evidence"),
      ),
    ).toThrow(/Conflicting evidence observation identity/);
    expect(() =>
      store.appendEvidenceObservation(memory.digest, {
        ...first,
        observationId: "different-id",
        kind: "COUNTEREXAMPLE",
      }),
    ).toThrow(/Conflicting evidence identity/);
    expect(store.evidenceHistory(memory.digest)).toHaveLength(1);
  });

  it("rejects malformed digests, extra fields, and accessor-backed fields", () => {
    const store = deep();
    const memory = store.stage(candidate(), stagedAt);
    expect(() =>
      store.appendEvidenceObservation(memory.digest, {
        ...reproduction("bad-digest", caseA, "valid-evidence"),
        sourceCaseDigest: "not-a-digest",
      }),
    ).toThrow(/sourceCaseDigest/);
    expect(() =>
      store.appendEvidenceObservation(memory.digest, {
        ...reproduction("bad-run-digest", caseA, "valid-run-evidence"),
        sourceRunDigest: "not-a-digest",
      }),
    ).toThrow(/sourceRunDigest/);
    expect(() =>
      store.appendEvidenceObservation(memory.digest, {
        ...reproduction("extra-field", caseA, "extra-evidence"),
        surprise: true,
      } as MemoryEvidenceObservation),
    ).toThrow(/unknown or missing fields/);

    const accessor = reproduction("accessor", caseA, "accessor-evidence") as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessor, "evidenceDigest", {
      enumerable: true,
      get: () => sha256Digest("accessor-evidence"),
    });
    expect(() =>
      store.appendEvidenceObservation(
        memory.digest,
        accessor as unknown as MemoryEvidenceObservation,
      ),
    ).toThrow(/accessors/);
  });

  it("does not count repeated observations from one later Case as independent", () => {
    const store = deep();
    const memory = store.stage(candidate(), stagedAt);
    store.appendEvidenceObservation(
      memory.digest,
      reproduction("same-case-a", caseA, "same-case-evidence-a"),
    );
    store.appendEvidenceObservation(
      memory.digest,
      reproduction("same-case-b", caseA, "same-case-evidence-b"),
    );
    store.appendEvidenceObservation(
      memory.digest,
      review(
        "same-case-contamination",
        "CONTAMINATION",
        caseC,
        "same-case-contamination-evidence",
        true,
      ),
    );
    const result = store.adjudicateEvidence(memory.digest, "2026-09-08T10:00:00.000Z");
    expect(result.evidence.evidence.reproductionDigests).toHaveLength(1);
    expect(result.decision.decision).toBe("PENDING");
    expect(result.decision.reasons).toContain(
      "candidate requires at least 2 independently attributed reproductions",
    );
    store.appendEvidenceObservation(
      memory.digest,
      reproduction("later-independent-case", caseB, "later-independent-evidence"),
    );
    expect(
      store.adjudicateEvidence(memory.digest, "2026-09-09T10:00:00.000Z").decision.decision,
    ).toBe("ADMIT");
  });

  it("blocks admission when any counterexample is present", () => {
    const store = deep();
    const memory = store.stage(candidate(), stagedAt);
    appendPassingBasis(store, memory.digest);
    store.appendEvidenceObservation(memory.digest, {
      protocol: "jevyr.memory-evidence-observation/1",
      observationId: "counterexample",
      kind: "COUNTEREXAMPLE",
      sourceCaseDigest: caseC,
      evidenceDigest: sha256Digest("counterexample-evidence"),
      observedAt: "2026-09-07T11:00:00.000Z",
    });
    const result = store.adjudicateEvidence(memory.digest, "2026-09-08T10:00:00.000Z");
    expect(result.decision.decision).toBe("REJECT");
    expect(result.decision.reasons).toContain("candidate has counterexample evidence");
  });

  it("blocks admission on an unresolved contradiction", () => {
    const store = deep();
    const memory = store.stage(candidate(), stagedAt);
    appendPassingBasis(store, memory.digest);
    store.appendEvidenceObservation(memory.digest, {
      protocol: "jevyr.memory-evidence-observation/1",
      observationId: "unresolved-contradiction",
      kind: "UNRESOLVED_CONTRADICTION",
      sourceCaseDigest: caseC,
      evidenceDigest: sha256Digest("unresolved-contradiction-evidence"),
      observedAt: "2026-09-07T11:00:00.000Z",
    });
    const result = store.adjudicateEvidence(memory.digest, "2026-09-08T10:00:00.000Z");
    expect(result.decision.decision).toBe("PENDING");
    expect(result.decision.reasons).toContain("candidate has unresolved contradictions");
  });

  it("lets any real contamination failure dominate passing checks", () => {
    const store = deep();
    const memory = store.stage(candidate(), stagedAt);
    appendPassingBasis(store, memory.digest);
    store.appendEvidenceObservation(
      memory.digest,
      review("contamination-fail", "CONTAMINATION", caseA, "contamination-failure-evidence", false),
    );
    const result = store.adjudicateEvidence(memory.digest, "2026-09-08T10:00:00.000Z");
    expect(result.decision.decision).toBe("REJECT");
    expect(result.decision.reasons).toContain("candidate failed contamination testing");
    expect(result.evidence.evidence.contaminationEvidenceDigest).toBe(
      sha256Digest("contamination-failure-evidence"),
    );
  });

  it("admits only after two independent reproductions and a real passing contamination observation", () => {
    const store = deep();
    const memory = store.stage(candidate(), stagedAt);
    appendPassingBasis(store, memory.digest);
    const result = store.adjudicateEvidence(memory.digest, "2026-09-08T10:00:00.000Z");
    expect(result.decision.decision).toBe("ADMIT");
    expect(result.decision.tribunalEvidenceDigest).toBe(result.evidence.evidenceDigest);
    expect(
      result.evidence.evidence.reproductionAttributions?.map((entry) => entry.sourceCaseDigest),
    ).toEqual([caseA, caseB].sort());
    expect(result.evidence.evidence.contaminationEvidenceDigest).toBe(
      sha256Digest("contamination-evidence"),
    );
    const exported = store.exportProject("project-evidence-ledger");
    expect(exported.observations).toHaveLength(3);
    expect(exported.evidenceSnapshots).toHaveLength(1);
    expect(exported.evidenceSnapshots[0]?.evidenceDigest).toBe(result.evidence.evidenceDigest);
    expect(() =>
      store.appendEvidenceObservation(
        memory.digest,
        reproduction("too-late", caseC, "late-evidence"),
      ),
    ).toThrow(/sealed by its Tribunal decision/);
  });

  it("keeps SELF abstraction private and requires a real privacy-review observation", () => {
    const store = deep();
    const source = store.stage(candidate(), stagedAt);
    const self = store.stage(
      candidate({
        scope: "SELF",
        projectId: undefined,
        caseDigest: undefined,
        sourceMemoryDigests: [source.digest],
        abstractSummary: "An abstract causal-boundary search strategy.",
        content: {
          strategyFingerprint: "abstract-causal-boundary",
          version: "1",
        },
      }),
      "2026-09-04T10:01:00.000Z",
    );
    appendPassingBasis(store, self.digest);
    const withoutPrivacy = store.adjudicateEvidence(self.digest, "2026-09-08T10:00:00.000Z");
    expect(withoutPrivacy.decision.decision).toBe("PENDING");
    expect(withoutPrivacy.decision.reasons).toContain(
      "cross-project abstraction lacks privacy evidence",
    );
    store.appendEvidenceObservation(
      self.digest,
      review("self-privacy", "PRIVACY_REVIEW", caseC, "self-privacy-evidence", true),
    );
    const admitted = store.adjudicateEvidence(self.digest, "2026-09-08T10:01:00.000Z");
    expect(admitted.decision.decision).toBe("ADMIT");
    expect(admitted.evidence.evidence.privacyEvidenceDigest).toBe(
      sha256Digest("self-privacy-evidence"),
    );
    expect(self.candidate.projectId).toBeUndefined();
    expect(self.candidate.caseDigest).toBeUndefined();
  });

  it("cannot persist a fabricated direct ADMIT without a durable snapshot", () => {
    const store = deep();
    const fakeObservationDigests = [
      sha256Digest("fake-observation-a"),
      sha256Digest("fake-observation-b"),
      sha256Digest("fake-observation-c"),
    ];
    expect(() =>
      store.submit(
        candidate(),
        {
          reproductionDigests: [sha256Digest("fake-a"), sha256Digest("fake-b")],
          counterexampleDigests: [],
          unresolvedContradictions: 0,
          contaminationPassed: true,
          contaminationEvidenceDigest: sha256Digest("fake-contamination"),
          privacyReviewPassed: false,
          reproductionAttributions: [
            { sourceCaseDigest: caseA, evidenceDigest: sha256Digest("fake-a") },
            { sourceCaseDigest: caseB, evidenceDigest: sha256Digest("fake-b") },
          ],
          counterexampleAttributions: [],
          contaminationAttribution: {
            sourceCaseDigest: caseC,
            evidenceDigest: sha256Digest("fake-contamination"),
          },
          unresolvedContradictionDigests: [],
          observationDigests: fakeObservationDigests,
        },
        stagedAt,
      ),
    ).toThrow(/durable snapshot derived from stored observations/);
  });

  it("persists append order and derives the same evidence after reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-memory-evidence-"));
    temporaryRoots.push(root);
    const path = join(root, "temporal-deep.sqlite");
    const first = deep(path);
    const memory = first.stage(candidate(), stagedAt);
    first.appendEvidenceObservation(
      memory.digest,
      reproduction("persist-b", caseB, "persist-evidence-b"),
    );
    first.appendEvidenceObservation(
      memory.digest,
      reproduction("persist-a", caseA, "persist-evidence-a"),
    );
    first.appendEvidenceObservation(
      memory.digest,
      review(
        "persist-contamination",
        "CONTAMINATION",
        caseC,
        "persist-contamination-evidence",
        true,
      ),
    );
    const before = first.deriveTribunalEvidence(memory.digest);
    first.close();
    opened.pop();

    const reopened = deep(path);
    const history = reopened.evidenceHistory(memory.digest);
    const after = reopened.deriveTribunalEvidence(memory.digest);
    expect(history.map((entry) => entry.observation.observationId)).toEqual([
      "persist-b",
      "persist-a",
      "persist-contamination",
    ]);
    expect(after).toEqual(before);
    expect(
      reopened.adjudicateEvidence(memory.digest, "2026-09-08T10:00:00.000Z").decision.decision,
    ).toBe("ADMIT");
    reopened.close();
    opened.pop();

    const final = deep(path);
    const exported = final.exportProject("project-evidence-ledger");
    expect(exported.decisions[0]?.decision).toBe("ADMIT");
    expect(exported.evidenceSnapshots[0]?.evidenceDigest).toBe(before.evidenceDigest);
  });

  it("derives a canonical snapshot independent of observation arrival order", () => {
    const left = deep();
    const right = deep();
    const leftMemory = left.stage(candidate(), stagedAt);
    const rightMemory = right.stage(candidate(), stagedAt);
    const observations = [
      reproduction("canonical-a", caseA, "canonical-evidence-a"),
      reproduction("canonical-b", caseB, "canonical-evidence-b"),
      review(
        "canonical-contamination",
        "CONTAMINATION",
        caseC,
        "canonical-contamination-evidence",
        true,
      ),
    ] as const;
    for (const observation of observations)
      left.appendEvidenceObservation(leftMemory.digest, observation);
    for (const observation of [...observations].reverse())
      right.appendEvidenceObservation(rightMemory.digest, observation);

    expect(right.deriveTribunalEvidence(rightMemory.digest)).toEqual(
      left.deriveTribunalEvidence(leftMemory.digest),
    );
    expect(
      right.evidenceHistory(rightMemory.digest).map((entry) => entry.observation.observationId),
    ).toEqual(["canonical-contamination", "canonical-b", "canonical-a"]);
  });

  it("migrates pre-snapshot decisions and pre-run evidence rows without discarding them", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-memory-migration-"));
    temporaryRoots.push(root);
    const path = join(root, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE memories (
        digest TEXT PRIMARY KEY,
        protocol TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('CASE', 'PROJECT', 'SELF')),
        kind TEXT NOT NULL,
        abstract_summary TEXT NOT NULL,
        content_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        project_id TEXT,
        case_digest TEXT,
        supersedes TEXT,
        staged_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE memory_decisions (
        id INTEGER PRIMARY KEY,
        decision_digest TEXT NOT NULL UNIQUE,
        memory_digest TEXT NOT NULL UNIQUE REFERENCES memories(digest) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK (decision IN ('ADMIT', 'REJECT')),
        reasons_json TEXT NOT NULL,
        decided_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE memory_evidence_observations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id TEXT NOT NULL UNIQUE,
        observation_digest TEXT NOT NULL UNIQUE,
        memory_digest TEXT NOT NULL REFERENCES memories(digest) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'REPRODUCTION', 'COUNTEREXAMPLE', 'UNRESOLVED_CONTRADICTION',
          'CONTAMINATION', 'PRIVACY_REVIEW'
        )),
        source_case_digest TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        passed INTEGER CHECK (passed IS NULL OR passed IN (0, 1)),
        observed_at TEXT NOT NULL,
        observation_json TEXT NOT NULL,
        UNIQUE (memory_digest, evidence_digest),
        CHECK (
          (kind IN ('CONTAMINATION', 'PRIVACY_REVIEW') AND passed IN (0, 1))
          OR
          (kind IN ('REPRODUCTION', 'COUNTEREXAMPLE', 'UNRESOLVED_CONTRADICTION') AND passed IS NULL)
        )
      ) STRICT;
    `);
    legacy.close();

    const migrated = deep(path);
    const submitted = migrated.submit(
      candidate(),
      {
        reproductionDigests: [],
        counterexampleDigests: [],
        unresolvedContradictions: 0,
        contaminationPassed: false,
        privacyReviewPassed: false,
      },
      stagedAt,
    );
    expect(submitted.decision.decision).toBe("PENDING");
    expect(migrated.exportProject("project-evidence-ledger").decisions).toHaveLength(0);
    const sourceRunDigest = sha256Digest("migrated-source-run");
    migrated.appendEvidenceObservation(submitted.memory.digest, {
      ...reproduction("migrated-observation", caseA, "migrated-evidence"),
      sourceRunDigest,
    });
    expect(
      migrated.evidenceHistory(submitted.memory.digest)[0]?.observation.sourceRunDigest,
    ).toBe(sourceRunDigest);
  });
});
