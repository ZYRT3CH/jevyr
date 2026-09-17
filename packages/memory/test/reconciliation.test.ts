import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Digest, type JsonValue } from "@jevyr/protocol";
import {
  MAX_VERIFIED_MEMORY_LINEAGE,
  MEMORY_REPRODUCIBILITY_PROTOCOL,
  TemporalDeep,
  assertMemoryReproducibilityFingerprint,
  assertVerifiedMemoryLineage,
  memoryReproducibilityFingerprint,
  memoryReproducibilityFingerprintDigest,
  type MemoryCandidate,
  type MemoryEvidenceObservation,
  type MemoryReproducibilityFingerprint,
} from "../src/index.js";

const opened: TemporalDeep[] = [];
const temporaryRoots: string[] = [];
const originCase = sha256Digest("reconciliation-origin-case");
const originRun = sha256Digest("reconciliation-origin-run");
const intent = sha256Digest("reconciliation-intent");
const material = sha256Digest("reconciliation-material");
const stagedAt = "2026-09-04T10:00:00.000Z";

afterEach(async () => {
  while (opened.length > 0) opened.pop()?.close();
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function fingerprint(): MemoryReproducibilityFingerprint {
  return {
    protocol: MEMORY_REPRODUCIBILITY_PROTOCOL,
    origin: { caseDigest: originCase, runDigest: originRun },
    task: {
      intentContractDigest: intent,
      subjectMaterialCaptureDigest: material,
    },
    mechanism: {
      policyDigest: sha256Digest("reconciliation-policy"),
      genomeDigest: sha256Digest("reconciliation-genome"),
      searchProfileDigest: sha256Digest("seed-independent-search-profile"),
      assayFrontierDigest: sha256Digest("reconciliation-assays"),
    },
    outcome: {
      integrity: "VALID",
      creation: "CONCEIVED",
      embodiment: "BUILT",
      judgment: "ACCEPT",
      feasibilityProfile: ["BRIDGEABLE", "BUILDABLE_NOW"],
      selectedFeasibility: "BUILDABLE_NOW",
      basisCodes: ["SEALED_OBLIGATIONS_SATISFIED"],
    },
  };
}

function candidate(content: JsonValue = { reproducibility: fingerprint() }): MemoryCandidate {
  return {
    protocol: "jevyr.memory/1",
    scope: "PROJECT",
    kind: "descriptor",
    abstractSummary: "Exact signed outcome trace; no semantic generalization claimed.",
    content,
    sourceMemoryDigests: [],
    evidenceDigests: [sha256Digest("origin-evidence")],
    projectId: "project-reconciliation",
    caseDigest: originCase,
  };
}

function observations(
  sourceCaseDigest: string,
  observedAt: string,
  sourceRunDigest = sha256Digest(`run:${sourceCaseDigest}`),
): readonly MemoryEvidenceObservation[] {
  const suffix = sourceRunDigest.slice(-12);
  return [
    {
      protocol: "jevyr.memory-evidence-observation/1",
      observationId: `reconcile:${suffix}:outcome`,
      kind: "REPRODUCTION",
      sourceCaseDigest,
      sourceRunDigest,
      evidenceDigest: sha256Digest(`outcome:${sourceRunDigest}`),
      observedAt,
    },
    {
      protocol: "jevyr.memory-evidence-observation/1",
      observationId: `reconcile:${suffix}:contamination`,
      kind: "CONTAMINATION",
      sourceCaseDigest,
      sourceRunDigest,
      evidenceDigest: sha256Digest(`contamination:${sourceRunDigest}`),
      observedAt,
      passed: true,
    },
  ];
}

function lineageCandidate(
  label: string,
  sourceMemoryDigests: readonly string[] = [],
  projectId = "project-reconciliation",
): MemoryCandidate {
  return {
    protocol: "jevyr.memory/1",
    scope: "PROJECT",
    kind: "descriptor",
    abstractSummary: `Durable lineage fixture ${label}.`,
    content: { descriptor: label },
    sourceMemoryDigests,
    evidenceDigests: [sha256Digest(`lineage-origin-evidence:${label}`)],
    projectId,
    caseDigest: sha256Digest(`lineage-origin-case:${label}`),
  };
}

function admitLineageCandidate(
  store: TemporalDeep,
  value: MemoryCandidate,
  label: string,
) {
  const memory = store.stage(value, stagedAt);
  const first = observations(
    sha256Digest(`lineage-source-case-a:${label}`),
    "2026-09-05T10:00:00.000Z",
    sha256Digest(`lineage-source-run-a:${label}`),
  );
  const second = observations(
    sha256Digest(`lineage-source-case-b:${label}`),
    "2026-09-06T10:00:00.000Z",
    sha256Digest(`lineage-source-run-b:${label}`),
  );
  expect(store.reconcileEvidenceBatch(
    memory.digest,
    first,
    "2026-09-05T10:00:00.000Z",
  ).decision.decision).toBe("PENDING");
  expect(store.reconcileEvidenceBatch(
    memory.digest,
    second,
    "2026-09-06T10:00:00.000Z",
  ).decision.decision).toBe("ADMIT");
  return memory;
}

describe("narrow reproducibility fingerprints", () => {
  it("accepts only the exact closed and canonically sorted contract", () => {
    const value = fingerprint();
    assert.doesNotThrow(() => assertMemoryReproducibilityFingerprint(value));
    expect(memoryReproducibilityFingerprint(candidate())).toEqual(value);
    expect(memoryReproducibilityFingerprintDigest(value)).toBe(
      memoryReproducibilityFingerprintDigest(structuredClone(value)),
    );
    expect(() => assertMemoryReproducibilityFingerprint({ ...value, modelSimilarity: 1 })).toThrow(
      /unknown or missing fields/,
    );
    expect(() => assertMemoryReproducibilityFingerprint({
      ...value,
      outcome: { ...value.outcome, feasibilityProfile: ["BUILDABLE_NOW", "BRIDGEABLE"] },
    })).toThrow(/sorted feasibility/);
  });

  it("filters exact-task memory before its content can be returned to a Mind", () => {
    const store = new TemporalDeep();
    opened.push(store);
    const memory = store.stage(candidate(), stagedAt);
    store.reconcileEvidenceBatch(
      memory.digest,
      observations(sha256Digest("source-a"), "2026-09-05T10:00:00.000Z"),
      "2026-09-05T10:00:00.000Z",
    );
    store.reconcileEvidenceBatch(
      memory.digest,
      observations(sha256Digest("source-b"), "2026-09-06T10:00:00.000Z"),
      "2026-09-06T10:00:00.000Z",
    );

    const base = {
      projectId: "project-reconciliation",
      caseDigest: originCase,
      stage: "recombine" as const,
    };
    expect(store.retrieve(base)).toEqual([]);
    expect(store.retrieve({
      ...base,
      caseDigest: sha256Digest("different-case-content"),
      intentContractDigest: intent,
      subjectMaterialCaptureDigest: material,
    })).toEqual([]);
    expect(store.retrieve({
      ...base,
      intentContractDigest: sha256Digest("different-intent"),
      subjectMaterialCaptureDigest: material,
    })).toEqual([]);
    expect(store.retrieve({
      ...base,
      intentContractDigest: intent,
      subjectMaterialCaptureDigest: material,
    })).toHaveLength(1);
    expect(() => store.retrieve({ ...base, intentContractDigest: intent })).toThrow(/requires both/);
  });

  it("fails closed on a malformed reserved fingerprint instead of exposing it", () => {
    const store = new TemporalDeep();
    opened.push(store);
    const malformed = store.stage(candidate({
      reproducibility: { ...fingerprint(), untrustedSimilarity: 0.99 },
    }), stagedAt);
    expect(() => store.reconcileEvidenceBatch(
      malformed.digest,
      observations(sha256Digest("malformed-source-a"), "2026-09-05T10:00:00.000Z"),
      "2026-09-05T10:00:00.000Z",
    )).toThrow(/unknown or missing fields/);
    expect(store.retrieve({
      projectId: "project-reconciliation",
      caseDigest: sha256Digest("malformed-retrieval-case"),
      stage: "recombine",
      intentContractDigest: intent,
      subjectMaterialCaptureDigest: material,
    })).toEqual([]);
  });
});

describe("atomic idempotent Tribunal reconciliation", () => {
  it("counts identical Case content only through distinct authenticated run identities", () => {
    const store = new TemporalDeep();
    opened.push(store);
    const memory = store.stage(candidate(), stagedAt);
    const repeatedCase = sha256Digest("same-exact-case-content");
    const firstRun = sha256Digest("same-case-run-a");
    const secondRun = sha256Digest("same-case-run-b");
    const first = store.reconcileEvidenceBatch(
      memory.digest,
      observations(repeatedCase, "2026-09-05T10:00:00.000Z", firstRun),
      "2026-09-05T10:00:00.000Z",
    );
    expect(first.decision.decision).toBe("PENDING");
    const replayUnderNewLabels = observations(
      repeatedCase,
      "2026-09-05T11:00:00.000Z",
      firstRun,
    ).map((entry) => ({
      ...entry,
      observationId: `${entry.observationId}:forged-alias`,
      evidenceDigest: sha256Digest(`${entry.evidenceDigest}:forged-alias`),
    })) as readonly MemoryEvidenceObservation[];
    const aliased = store.reconcileEvidenceBatch(
      memory.digest,
      replayUnderNewLabels,
      "2026-09-05T11:00:00.000Z",
    );
    expect(aliased.decision.decision).toBe("PENDING");
    expect(aliased.evidence.evidence.reproductionAttributions).toHaveLength(1);
    const second = store.reconcileEvidenceBatch(
      memory.digest,
      observations(repeatedCase, "2026-09-06T10:00:00.000Z", secondRun),
      "2026-09-06T10:00:00.000Z",
    );
    expect(second.decision.decision).toBe("ADMIT");
    expect(second.evidence.evidence.reproductionAttributions?.map(
      (entry) => entry.sourceRunDigest,
    )).toEqual([firstRun, secondRun].sort());
    const originObservation = observations(
      originCase,
      "2026-09-07T10:00:00.000Z",
      originRun,
    )[0] as MemoryEvidenceObservation;
    expect(() => store.appendEvidenceObservation(memory.digest, {
      ...originObservation,
      observationId: "origin-run-cannot-reproduce",
    })).toThrow(/origin Case execution/);
  });

  it("recovers exact PENDING and ADMIT batches and rejects conflicting sealed retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-reconciliation-"));
    temporaryRoots.push(root);
    const path = join(root, "memory.sqlite");
    const first = new TemporalDeep(path);
    opened.push(first);
    const memory = first.stage(candidate(), stagedAt);
    const sourceA = sha256Digest("atomic-source-a");
    const sourceB = sha256Digest("atomic-source-b");
    const batchA = observations(sourceA, "2026-09-05T10:00:00.000Z");
    const pending = first.reconcileEvidenceBatch(
      memory.digest,
      batchA,
      "2026-09-05T10:00:00.000Z",
    );
    expect(pending.insertedObservations).toBe(2);
    expect(pending.decision.decision).toBe("PENDING");
    const pendingRetry = first.reconcileEvidenceBatch(
      memory.digest,
      batchA,
      "2026-09-05T10:00:00.000Z",
    );
    expect(pendingRetry.insertedObservations).toBe(0);
    expect(pendingRetry.evidence).toEqual(pending.evidence);

    const admitted = first.reconcileEvidenceBatch(
      memory.digest,
      observations(sourceB, "2026-09-06T10:00:00.000Z"),
      "2026-09-06T10:00:00.000Z",
    );
    expect(admitted.insertedObservations).toBe(2);
    expect(admitted.decision.decision).toBe("ADMIT");
    first.close();
    opened.pop();

    const recovered = new TemporalDeep(path);
    opened.push(recovered);
    const exactRetry = recovered.reconcileEvidenceBatch(
      memory.digest,
      observations(sourceB, "2026-09-06T10:00:00.000Z"),
      "2026-09-09T10:00:00.000Z",
    );
    expect(exactRetry.insertedObservations).toBe(0);
    expect(exactRetry.decision).toEqual(admitted.decision);
    expect(() => recovered.reconcileEvidenceBatch(
      memory.digest,
      [{
        ...(observations(sourceB, "2026-09-06T10:00:00.000Z")[0] as MemoryEvidenceObservation),
        evidenceDigest: sha256Digest("conflicting-sealed-retry"),
      }],
      "2026-09-09T10:00:00.000Z",
    )).toThrow(/Conflicting evidence observation identity/);
  });

  it("rolls back the whole batch when a later observation conflicts", () => {
    const store = new TemporalDeep();
    opened.push(store);
    const memory = store.stage(candidate(), stagedAt);
    const source = sha256Digest("rollback-source");
    const batch = observations(source, "2026-09-05T10:00:00.000Z");
    expect(() => store.reconcileEvidenceBatch(
      memory.digest,
      [batch[0] as MemoryEvidenceObservation, {
        ...(batch[1] as MemoryEvidenceObservation),
        evidenceDigest: batch[0]?.evidenceDigest as string,
      }],
      "2026-09-05T10:00:00.000Z",
    )).toThrow(/Conflicting evidence identity/);
    expect(store.evidenceHistory(memory.digest)).toEqual([]);
  });

  it("serializes two durable connections without losing either source", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-reconciliation-concurrent-"));
    temporaryRoots.push(root);
    const path = join(root, "memory.sqlite");
    const left = new TemporalDeep(path);
    const right = new TemporalDeep(path);
    opened.push(left, right);
    const memory = left.stage(candidate(), stagedAt);
    const results = await Promise.all([
      Promise.resolve().then(() => left.reconcileEvidenceBatch(
        memory.digest,
        observations(sha256Digest("connection-left"), "2026-09-05T10:00:00.000Z"),
        "2026-09-05T10:00:00.000Z",
      )),
      Promise.resolve().then(() => right.reconcileEvidenceBatch(
        memory.digest,
        observations(sha256Digest("connection-right"), "2026-09-06T10:00:00.000Z"),
        "2026-09-06T10:00:00.000Z",
      )),
    ]);
    expect(results.some((result) => result.decision.decision === "ADMIT")).toBe(true);
    expect(left.evidenceHistory(memory.digest)).toHaveLength(4);
    expect(left.projectMemoryStates("project-reconciliation")[0]?.decision?.decision).toBe("ADMIT");
  });

  it("does not blindly accept an exact retry when the sealed snapshot is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-reconciliation-corrupt-"));
    temporaryRoots.push(root);
    const path = join(root, "memory.sqlite");
    const store = new TemporalDeep(path);
    opened.push(store);
    const memory = store.stage(candidate(), stagedAt);
    const batchA = observations(sha256Digest("corrupt-source-a"), "2026-09-05T10:00:00.000Z");
    const batchB = observations(sha256Digest("corrupt-source-b"), "2026-09-06T10:00:00.000Z");
    store.reconcileEvidenceBatch(memory.digest, batchA, "2026-09-05T10:00:00.000Z");
    store.reconcileEvidenceBatch(memory.digest, batchB, "2026-09-06T10:00:00.000Z");
    store.close();
    opened.pop();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE memory_evidence_snapshots SET evidence_json = ? WHERE memory_digest = ?")
      .run("{}", memory.digest);
    raw.close();
    const reopened = new TemporalDeep(path);
    opened.push(reopened);
    expect(() => reopened.reconcileEvidenceBatch(
      memory.digest,
      batchB,
      "2026-09-09T10:00:00.000Z",
    )).toThrow(/reproductionDigests|Tribunal evidence/);
  });
});

describe("verified transitive memory lineage", () => {
  it("reconstructs the fixed point and binds independently re-derived admissions", () => {
    const store = new TemporalDeep();
    opened.push(store);
    const root = admitLineageCandidate(store, lineageCandidate("root"), "root");
    const descendant = admitLineageCandidate(
      store,
      lineageCandidate("descendant", [root.digest]),
      "descendant",
    );
    const lineage = store.verifiedMemoryLineage(
      "project-reconciliation",
      [descendant.digest],
    );
    expect(lineage.rootMemoryDigests).toEqual([descendant.digest]);
    expect(lineage.memoryDigests).toEqual([descendant.digest, root.digest].sort());
    expect(lineage.memoryDigests).toHaveLength(2);
    assert.doesNotThrow(() => assertVerifiedMemoryLineage(lineage));
    expect(() => assertVerifiedMemoryLineage(structuredClone(lineage))).toThrow(
      /exact closure issued by Temporal Deep/,
    );
  });

  it("rejects missing, pending, corrupt, and direct cross-project lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-lineage-adversarial-"));
    temporaryRoots.push(root);
    const path = join(root, "memory.sqlite");
    const store = new TemporalDeep(path);
    opened.push(store);
    expect(() => store.verifiedMemoryLineage(
      "project-reconciliation",
      [sha256Digest("missing-lineage-memory")],
    )).toThrow(/unavailable memory/);

    const pending = store.stage(lineageCandidate("pending"), stagedAt);
    expect(() => store.verifiedMemoryLineage(
      "project-reconciliation",
      [pending.digest],
    )).toThrow(/no durable ADMIT/);

    const foreign = admitLineageCandidate(
      store,
      lineageCandidate("foreign", [], "foreign-project"),
      "foreign",
    );
    expect(() => store.verifiedMemoryLineage(
      "project-reconciliation",
      [foreign.digest],
    )).toThrow(/incompatible project boundary/);

    const corrupt = admitLineageCandidate(store, lineageCandidate("corrupt"), "corrupt");
    const raw = new DatabaseSync(path);
    raw.prepare(
      "UPDATE memory_evidence_snapshots SET evidence_json = ? WHERE memory_digest = ?",
    ).run("{}", corrupt.digest);
    raw.close();
    expect(() => store.verifiedMemoryLineage(
      "project-reconciliation",
      [corrupt.digest],
    )).toThrow(/reproductionDigests|Tribunal evidence/);
  });

  it("permits only an admitted SELF abstraction to bridge project ancestry", () => {
    const store = new TemporalDeep();
    opened.push(store);
    const foreign = admitLineageCandidate(
      store,
      lineageCandidate("self-source", [], "foreign-project"),
      "self-source",
    );
    const selfCandidate: MemoryCandidate = {
      protocol: "jevyr.memory/1",
      scope: "SELF",
      kind: "descriptor",
      abstractSummary: "Privacy-reviewed cross-project abstraction.",
      content: { descriptor: "abstract-only" },
      sourceMemoryDigests: [foreign.digest],
      evidenceDigests: [sha256Digest("self-origin-evidence")],
    };
    const self = store.stage(selfCandidate, stagedAt);
    const first = observations(
      sha256Digest("self-source-case-a"),
      "2026-09-05T10:00:00.000Z",
      sha256Digest("self-source-run-a"),
    );
    const second = observations(
      sha256Digest("self-source-case-b"),
      "2026-09-06T10:00:00.000Z",
      sha256Digest("self-source-run-b"),
    );
    store.reconcileEvidenceBatch(self.digest, first, "2026-09-05T10:00:00.000Z");
    const admitted = store.reconcileEvidenceBatch(self.digest, [
      ...second,
      {
        protocol: "jevyr.memory-evidence-observation/1",
        observationId: "self-privacy-review",
        kind: "PRIVACY_REVIEW",
        sourceCaseDigest: sha256Digest("self-privacy-case"),
        sourceRunDigest: sha256Digest("self-privacy-run"),
        evidenceDigest: sha256Digest("self-privacy-evidence"),
        observedAt: "2026-09-06T10:00:00.000Z",
        passed: true,
      },
    ], "2026-09-06T10:00:00.000Z");
    expect(admitted.decision.decision).toBe("ADMIT");

    const lineage = store.verifiedMemoryLineage("project-reconciliation", [self.digest]);
    expect(lineage.memoryDigests).toEqual([foreign.digest, self.digest].sort());
  });

  it("detects cyclic persisted graphs and bounds traversal before unbounded work", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-lineage-bounds-"));
    temporaryRoots.push(root);
    const path = join(root, "memory.sqlite");
    const store = new TemporalDeep(path);
    opened.push(store);
    const raw = new DatabaseSync(path);
    const insert = raw.prepare(
      `INSERT INTO memories
        (digest, protocol, scope, kind, abstract_summary, content_json,
         source_json, evidence_json, project_id, case_digest, supersedes, staged_at)
       VALUES (?, 'jevyr.memory/1', 'PROJECT', 'descriptor', ?, '{}', ?, ?,
               'project-reconciliation', ?, NULL, ?)`,
    );
    const insertRaw = (digest: string, label: string, sources: readonly string[]) => {
      insert.run(
        digest,
        `Raw adversarial lineage ${label}.`,
        JSON.stringify(sources),
        JSON.stringify([sha256Digest(`raw-evidence:${label}`)]),
        sha256Digest(`raw-case:${label}`),
        stagedAt,
      );
    };
    const cycleA = sha256Digest("lineage-cycle-a");
    const cycleB = sha256Digest("lineage-cycle-b");
    insertRaw(cycleA, "cycle-a", [cycleB]);
    insertRaw(cycleB, "cycle-b", [cycleA]);

    const chain = Array.from(
      { length: MAX_VERIFIED_MEMORY_LINEAGE + 1 },
      (_, index) => sha256Digest(`over-limit-lineage:${index}`),
    );
    raw.exec("BEGIN");
    try {
      for (let index = 0; index < chain.length; index += 1) {
        insertRaw(
          chain[index] as string,
          `limit-${index}`,
          index + 1 < chain.length ? [chain[index + 1] as string] : [],
        );
      }
      raw.exec("COMMIT");
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    }
    raw.close();

    expect(() => store.verifiedMemoryLineage(
      "project-reconciliation",
      [cycleA],
    )).toThrow(/contains a cycle/);
    expect(() => store.verifiedMemoryLineage(
      "project-reconciliation",
      [chain[0] as string],
    )).toThrow(new RegExp(`exceeds ${MAX_VERIFIED_MEMORY_LINEAGE}`));
  });
});
