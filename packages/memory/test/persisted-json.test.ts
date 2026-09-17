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

const temporaryRoots: string[] = [];
const opened: TemporalDeep[] = [];
const stagedAt = "2026-09-04T10:00:00.000Z";

afterEach(async () => {
  while (opened.length > 0) opened.pop()?.close();
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function candidate(): MemoryCandidate {
  return {
    protocol: "jevyr.memory/1",
    scope: "PROJECT",
    kind: "strategy",
    abstractSummary: "Persisted JSON must remain exact before memory can influence a Case.",
    content: { strategyFingerprint: "strict-persistence-boundary" },
    sourceMemoryDigests: [],
    evidenceDigests: [sha256Digest("persisted-json-origin-evidence")],
    projectId: "persisted-json-project",
    caseDigest: sha256Digest("persisted-json-origin-case"),
  };
}

function reproduction(
  observationId: string,
  sourceLabel: string,
): MemoryEvidenceObservation {
  return {
    protocol: "jevyr.memory-evidence-observation/1",
    observationId,
    kind: "REPRODUCTION",
    sourceCaseDigest: sha256Digest(`case:${sourceLabel}`),
    sourceRunDigest: sha256Digest(`run:${sourceLabel}`),
    evidenceDigest: sha256Digest(`evidence:${sourceLabel}`),
    observedAt: "2026-09-05T10:00:00.000Z",
  };
}

async function stagedDatabase() {
  const root = await mkdtemp(join(tmpdir(), "jevyr-persisted-json-"));
  temporaryRoots.push(root);
  const path = join(root, "memory.sqlite");
  const store = new TemporalDeep(path);
  const memory = store.stage(candidate(), stagedAt);
  store.close();
  return { path, memory };
}

describe("strict persisted JSON ingestion", () => {
  it("rejects malformed JSON and shape-invalid stored lineage", async () => {
    const malformed = await stagedDatabase();
    const malformedDb = new DatabaseSync(malformed.path);
    malformedDb.prepare("UPDATE memories SET content_json = ? WHERE digest = ?")
      .run("{", malformed.memory.digest);
    malformedDb.close();
    const malformedStore = new TemporalDeep(malformed.path);
    opened.push(malformedStore);
    expect(() => malformedStore.projectMemoryStates("persisted-json-project")).toThrow(
      /Stored memory content is not valid JSON/,
    );

    const invalidShape = await stagedDatabase();
    const invalidShapeDb = new DatabaseSync(invalidShape.path);
    invalidShapeDb.prepare("UPDATE memories SET source_json = ? WHERE digest = ?")
      .run("{}", invalidShape.memory.digest);
    invalidShapeDb.close();
    const invalidShapeStore = new TemporalDeep(invalidShape.path);
    opened.push(invalidShapeStore);
    expect(() => invalidShapeStore.projectMemoryStates("persisted-json-project")).toThrow(
      /Stored memory source lineage must be a bounded array/,
    );
  });

  it("rejects escaped duplicate keys and rolls back a reconciliation completely", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-persisted-json-rollback-"));
    temporaryRoots.push(root);
    const path = join(root, "memory.sqlite");
    const first = new TemporalDeep(path);
    const memory = first.stage(candidate(), stagedAt);
    first.appendEvidenceObservation(memory.digest, reproduction("existing", "existing"));
    first.close();

    const raw = new DatabaseSync(path);
    raw.prepare(
      "UPDATE memory_evidence_observations SET observation_json = ? WHERE observation_id = ?",
    ).run(
      String.raw`{"protocol":"jevyr.memory-evidence-observation/1","observationId":"existing","\u006fbservationId":"forged"}`,
      "existing",
    );
    raw.close();

    const reopened = new TemporalDeep(path);
    opened.push(reopened);
    expect(() => reopened.reconcileEvidenceBatch(
      memory.digest,
      [reproduction("new-in-rolled-back-transaction", "new")],
      "2026-09-06T10:00:00.000Z",
    )).toThrow(/duplicate object key "observationId"/);
    reopened.close();
    opened.pop();

    const inspected = new DatabaseSync(path, { readOnly: true });
    const observations = inspected.prepare(
      "SELECT COUNT(*) AS count FROM memory_evidence_observations WHERE memory_digest = ?",
    ).get(memory.digest) as { count: number };
    const decisions = inspected.prepare(
      "SELECT COUNT(*) AS count FROM memory_decisions WHERE memory_digest = ?",
    ).get(memory.digest) as { count: number };
    const snapshots = inspected.prepare(
      "SELECT COUNT(*) AS count FROM memory_evidence_snapshots WHERE memory_digest = ?",
    ).get(memory.digest) as { count: number };
    inspected.close();
    expect(observations.count).toBe(1);
    expect(decisions.count).toBe(0);
    expect(snapshots.count).toBe(0);
  });
});
