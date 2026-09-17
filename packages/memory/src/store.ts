import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseJsonText } from "@jevyr/core";
import {
  canonicalize,
  digestJson,
  isSha256Digest,
  type JsonValue,
  type LifecycleStage,
} from "@jevyr/protocol";
import {
  assertMemoryEvidenceObservation,
  deriveTribunalEvidence as deriveEvidence,
  memoryEvidenceObservationDigest,
} from "./evidence.js";
import { memoryReproducibilityFingerprint } from "./reproducibility.js";
import { adjudicateMemory, assertTribunalEvidence, stageMemory } from "./tribunal.js";
import type {
  DerivedTribunalEvidence,
  EvidenceAdjudication,
  MemoryCandidate,
  MemoryDecision,
  MemoryEvidenceObservation,
  MemoryExport,
  ProjectMemoryState,
  ReconciledMemoryEvidence,
  RecordedInfluence,
  RetrievalRequest,
  RetrievedMemory,
  StoredMemory,
  StoredMemoryEvidenceObservation,
  TribunalEvidence,
  VerifiedMemoryLineage,
} from "./types.js";
import {
  MAX_MEMORY_EVIDENCE_OBSERVATIONS,
  MAX_VERIFIED_MEMORY_LINEAGE,
  MEMORY_LINEAGE_PROTOCOL,
  TRIBUNAL_EVIDENCE_SNAPSHOT_PROTOCOL,
} from "./types.js";

const RETRIEVAL_STAGES = new Set<LifecycleStage>([
  "recombine",
  "embody",
  "challenge",
  "assay",
  "reflex",
  "crystallize",
]);

const VERIFIED_MEMORY_LINEAGES = new WeakSet<object>();

/** Reject structurally forged lineage descriptors at the runtime boundary. */
export function assertVerifiedMemoryLineage(
  value: unknown,
): asserts value is VerifiedMemoryLineage {
  if (typeof value !== "object" || value === null || !VERIFIED_MEMORY_LINEAGES.has(value)) {
    throw new TypeError(
      "Memory lineage must be an exact closure issued by Temporal Deep verification.",
    );
  }
}

type MemoryRow = {
  digest: string;
  protocol: string;
  scope: MemoryCandidate["scope"];
  kind: MemoryCandidate["kind"];
  abstract_summary: string;
  content_json: string;
  source_json: string;
  evidence_json: string;
  project_id: string | null;
  case_digest: string | null;
  supersedes: string | null;
  staged_at: string;
};

type DecisionRow = {
  decision_digest: string;
  memory_digest: string;
  decision: MemoryDecision["decision"];
  reasons_json: string;
  decided_at: string;
  tribunal_evidence_digest: string | null;
};

type ObservationRow = {
  sequence: number;
  observation_id: string;
  observation_digest: string;
  memory_digest: string;
  protocol: string;
  kind: MemoryEvidenceObservation["kind"];
  source_case_digest: string;
  source_run_digest: string | null;
  evidence_digest: string;
  passed: number | null;
  observed_at: string;
  observation_json: string;
};

type EvidenceSnapshotRow = {
  evidence_digest: string;
  memory_digest: string;
  protocol: string;
  observation_digests_json: string;
  evidence_json: string;
};

type InfluenceRow = {
  case_digest: string;
  memory_digest: string;
  stage: LifecycleStage;
  weight: number;
  influence: RecordedInfluence["influence"];
  summary: string;
  observed_at: string;
};

type MemoryOriginIdentities = {
  readonly caseDigests: ReadonlySet<string>;
  readonly runDigests: ReadonlySet<string>;
  /** Origins that predate a committed run identity retain Case-level exclusion. */
  readonly legacyCaseDigests: ReadonlySet<string>;
};

function assertTimestamp(value: string, label: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(label + " must be a canonical UTC timestamp.");
  }
}

function parseStoredDigestArray(
  text: string,
  label: string,
  maximumEntries = 256,
): readonly string[] {
  const value = parseJsonText(text, label);
  if (
    !Array.isArray(value) ||
    value.length > maximumEntries ||
    !value.every(isSha256Digest) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError(`${label} must be a bounded array of unique SHA-256 digests.`);
  }
  return Object.freeze([...value]);
}

function parseStoredStringArray(
  text: string,
  label: string,
  maximumEntries = 4_096,
): readonly string[] {
  const value = parseJsonText(text, label);
  if (
    !Array.isArray(value) ||
    value.length > maximumEntries ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError(`${label} must be a bounded array of strings.`);
  }
  return Object.freeze([...value]);
}

function decodeMemoryRow(row: MemoryRow): StoredMemory {
  if (row.protocol !== "jevyr.memory/1") {
    throw new Error("Stored memory uses an unsupported protocol.");
  }
  if (!isSha256Digest(row.digest)) {
    throw new Error("Stored memory has an invalid content address.");
  }
  const candidate: MemoryCandidate = {
    protocol: row.protocol,
    scope: row.scope,
    kind: row.kind,
    abstractSummary: row.abstract_summary,
    content: parseJsonText(row.content_json, "Stored memory content") as JsonValue,
    sourceMemoryDigests: parseStoredDigestArray(
      row.source_json,
      "Stored memory source lineage",
    ),
    evidenceDigests: parseStoredDigestArray(
      row.evidence_json,
      "Stored memory evidence lineage",
    ),
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.case_digest !== null ? { caseDigest: row.case_digest } : {}),
    ...(row.supersedes !== null ? { supersedes: row.supersedes } : {}),
  };
  const normalized = stageMemory(candidate);
  return Object.freeze({ digest: row.digest, candidate: normalized.candidate });
}

function rowToMemory(row: MemoryRow): StoredMemory {
  const normalized = decodeMemoryRow(row);
  if (stageMemory(normalized.candidate).digest !== row.digest) {
    throw new Error("Stored memory failed digest verification.");
  }
  return normalized;
}

function rowToDecision(row: DecisionRow): MemoryDecision {
  if (
    !isSha256Digest(row.decision_digest) ||
    !isSha256Digest(row.memory_digest) ||
    (row.decision !== "ADMIT" && row.decision !== "REJECT") ||
    (row.tribunal_evidence_digest !== null &&
      !isSha256Digest(row.tribunal_evidence_digest))
  ) {
    throw new Error("Stored memory decision columns are invalid.");
  }
  assertTimestamp(row.decided_at, "Stored memory decision decidedAt");
  const reasons = parseStoredStringArray(row.reasons_json, "Stored memory decision reasons");
  const decision: MemoryDecision = Object.freeze({
    protocol: "jevyr.memory-decision/1",
    decisionDigest: row.decision_digest,
    memoryDigest: row.memory_digest,
    decision: row.decision,
    reasons,
    decidedAt: row.decided_at,
    ...(row.tribunal_evidence_digest !== null
      ? { tribunalEvidenceDigest: row.tribunal_evidence_digest }
      : {}),
  });
  const unsigned = {
    protocol: decision.protocol,
    memoryDigest: decision.memoryDigest,
    decision: decision.decision,
    reasons: decision.reasons,
    decidedAt: decision.decidedAt,
    ...(decision.tribunalEvidenceDigest === undefined
      ? {}
      : { tribunalEvidenceDigest: decision.tribunalEvidenceDigest }),
  };
  if (digestJson(unsigned as unknown as JsonValue) !== decision.decisionDigest) {
    throw new Error("Stored memory decision failed digest verification.");
  }
  return decision;
}

function rowToObservation(row: ObservationRow): StoredMemoryEvidenceObservation {
  if (
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !isSha256Digest(row.observation_digest) ||
    !isSha256Digest(row.memory_digest)
  ) {
    throw new Error("Stored evidence observation columns are invalid.");
  }
  const observation = parseJsonText(
    row.observation_json,
    "Stored evidence observation",
  );
  assertMemoryEvidenceObservation(observation);
  const expectedDigest = memoryEvidenceObservationDigest(row.memory_digest, observation);
  if (expectedDigest !== row.observation_digest)
    throw new Error("Stored evidence observation failed digest verification.");
  if (
    observation.protocol !== row.protocol ||
    observation.observationId !== row.observation_id ||
    observation.kind !== row.kind ||
    observation.sourceCaseDigest !== row.source_case_digest ||
    (observation.sourceRunDigest ?? null) !== (row.source_run_digest ?? null) ||
    observation.evidenceDigest !== row.evidence_digest ||
    observation.observedAt !== row.observed_at ||
    ("passed" in observation ? (observation.passed ? 1 : 0) : null) !== row.passed
  )
    throw new Error("Stored evidence observation columns do not match its payload.");
  return Object.freeze({
    sequence: row.sequence,
    observationDigest: row.observation_digest,
    memoryDigest: row.memory_digest,
    observation: Object.freeze(observation),
  });
}

function normalizeObservation(input: MemoryEvidenceObservation): MemoryEvidenceObservation {
  // Canonicalization rejects values that cannot be durably represented. Clone
  // without reparsing text so this path does not add a forgiving text boundary.
  canonicalize(input as unknown as JsonValue);
  const normalized = structuredClone(input);
  assertMemoryEvidenceObservation(normalized);
  return Object.freeze(normalized);
}

function rowToEvidenceSnapshot(row: EvidenceSnapshotRow): DerivedTribunalEvidence {
  if (row.protocol !== TRIBUNAL_EVIDENCE_SNAPSHOT_PROTOCOL)
    throw new Error("Stored Tribunal evidence snapshot uses an unsupported protocol.");
  if (!isSha256Digest(row.evidence_digest) || !isSha256Digest(row.memory_digest)) {
    throw new Error("Stored Tribunal evidence snapshot columns are invalid.");
  }
  const evidence = parseJsonText(row.evidence_json, "Stored Tribunal evidence snapshot");
  assertTribunalEvidence(evidence);
  const observationDigests = parseStoredDigestArray(
    row.observation_digests_json,
    "Stored Tribunal observation digests",
    MAX_MEMORY_EVIDENCE_OBSERVATIONS,
  );
  if (canonicalize(observationDigests) !== canonicalize(evidence.observationDigests ?? []))
    throw new Error("Stored Tribunal evidence observation set is invalid.");
  if (digestJson(evidence as unknown as JsonValue) !== row.evidence_digest)
    throw new Error("Stored Tribunal evidence failed digest verification.");
  return Object.freeze({
    protocol: TRIBUNAL_EVIDENCE_SNAPSHOT_PROTOCOL,
    memoryDigest: row.memory_digest,
    evidenceDigest: row.evidence_digest,
    observationDigests: Object.freeze([...observationDigests]),
    evidence: Object.freeze(evidence),
  });
}

function descriptorFrom(content: JsonValue): readonly number[] | undefined {
  if (content === null || Array.isArray(content) || typeof content !== "object") return undefined;
  const value = (content as { readonly [key: string]: JsonValue }).descriptor;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  )
    return undefined;
  return value as number[];
}

function descriptorSimilarity(query: readonly number[] | undefined, content: JsonValue) {
  if (!query || query.length === 0) return 0.5;
  const candidate = descriptorFrom(content);
  if (!candidate || candidate.length !== query.length) return 0.25;
  let squareSum = 0;
  for (let index = 0; index < query.length; index += 1) {
    const delta = (query[index] as number) - (candidate[index] as number);
    squareSum += delta * delta;
  }
  return Math.max(0, 1 - Math.sqrt(squareSum / query.length));
}

function influenceFor(kind: MemoryCandidate["kind"]): RetrievedMemory["influence"] {
  if (kind === "calibration") return "calibration_applied";
  if (kind === "strategy") return "strategy_selected";
  return "seeded_hypothesis";
}

export class TemporalDeep {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS memories (
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

      CREATE TABLE IF NOT EXISTS memory_decisions (
        id INTEGER PRIMARY KEY,
        decision_digest TEXT NOT NULL UNIQUE,
        memory_digest TEXT NOT NULL UNIQUE REFERENCES memories(digest) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK (decision IN ('ADMIT', 'REJECT')),
        reasons_json TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        tribunal_evidence_digest TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_evidence_observations (
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
        source_run_digest TEXT,
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

      CREATE TABLE IF NOT EXISTS memory_evidence_snapshots (
        evidence_digest TEXT PRIMARY KEY,
        memory_digest TEXT NOT NULL UNIQUE REFERENCES memories(digest) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        observation_digests_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_tombstones (
        id INTEGER PRIMARY KEY,
        target_digest TEXT NOT NULL UNIQUE REFERENCES memories(digest) ON DELETE CASCADE,
        evidence_digest TEXT NOT NULL,
        tombstoned_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_influences (
        id INTEGER PRIMARY KEY,
        case_digest TEXT NOT NULL,
        memory_digest TEXT NOT NULL REFERENCES memories(digest) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 0.2),
        influence TEXT NOT NULL,
        summary TEXT NOT NULL,
        observed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_project_idx
        ON memories(project_id, scope, kind);
      CREATE INDEX IF NOT EXISTS memory_case_idx
        ON memories(case_digest, scope, kind);
      CREATE INDEX IF NOT EXISTS influence_case_idx
        ON memory_influences(case_digest, id);
      CREATE INDEX IF NOT EXISTS memory_evidence_history_idx
        ON memory_evidence_observations(memory_digest, sequence);
      CREATE INDEX IF NOT EXISTS memory_evidence_source_idx
        ON memory_evidence_observations(memory_digest, source_case_digest, kind);
    `);
    const decisionColumns = this.#db
      .prepare("PRAGMA table_info(memory_decisions)")
      .all() as unknown as { name: string }[];
    if (!decisionColumns.some((column) => column.name === "tribunal_evidence_digest"))
      this.#db.exec("ALTER TABLE memory_decisions ADD COLUMN tribunal_evidence_digest TEXT");
    const observationColumns = this.#db
      .prepare("PRAGMA table_info(memory_evidence_observations)")
      .all() as unknown as { name: string }[];
    if (!observationColumns.some((column) => column.name === "source_run_digest")) {
      this.#db.exec(
        "ALTER TABLE memory_evidence_observations ADD COLUMN source_run_digest TEXT",
      );
    }
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS memory_evidence_run_idx
        ON memory_evidence_observations(memory_digest, source_run_digest, kind);
    `);
  }

  #memory(memoryDigest: string): StoredMemory {
    if (!isSha256Digest(memoryDigest))
      throw new TypeError("memoryDigest must be a SHA-256 digest.");
    const row = this.#db.prepare("SELECT * FROM memories WHERE digest = ?").get(memoryDigest) as
      | MemoryRow
      | undefined;
    if (!row) throw new Error("Unknown staged memory.");
    const memory = rowToMemory(row);
    if (stageMemory(memory.candidate).digest !== memory.digest)
      throw new Error("Stored memory failed digest verification.");
    return memory;
  }

  /**
   * Load and validate a lineage node's inert candidate shape without yet
   * accepting its row digest. Deferring that final equality until after its
   * outgoing edges are traversed lets corrupt cyclic graphs be rejected as
   * cycles while every acyclic node still receives the full hash check.
   */
  #lineageMemory(memoryDigest: string): StoredMemory {
    if (!isSha256Digest(memoryDigest)) {
      throw new TypeError("Memory lineage contains a non-SHA-256 digest.");
    }
    const row = this.#db.prepare("SELECT * FROM memories WHERE digest = ?").get(memoryDigest) as
      | MemoryRow
      | undefined;
    if (!row) throw new Error(`Memory lineage references an unavailable memory: ${memoryDigest}`);
    // Defer only the content-address equality until after traversal so a corrupt
    // cyclic graph is still reported as a cycle. Shape, JSON, and protocol are
    // fully validated here.
    return decodeMemoryRow(row);
  }

  #verifiedAdmissionBinding(memory: StoredMemory): {
    readonly memoryDigest: string;
    readonly decisionDigest: string;
    readonly tribunalEvidenceDigest: string;
  } {
    if (stageMemory(memory.candidate).digest !== memory.digest) {
      throw new Error("Memory lineage member failed candidate digest verification.");
    }
    const decisionRow = this.#db
      .prepare("SELECT * FROM memory_decisions WHERE memory_digest = ?")
      .get(memory.digest) as DecisionRow | undefined;
    if (!decisionRow || decisionRow.decision !== "ADMIT") {
      throw new Error("Memory lineage member has no durable ADMIT decision.");
    }
    const decision = rowToDecision(decisionRow);
    assertTimestamp(decision.decidedAt, "memory lineage decision decidedAt");
    if (
      decision.memoryDigest !== memory.digest
      || !decision.tribunalEvidenceDigest
      || !isSha256Digest(decision.tribunalEvidenceDigest)
    ) {
      throw new Error("Memory lineage member has a malformed ADMIT decision binding.");
    }
    const snapshotRow = this.#db
      .prepare("SELECT * FROM memory_evidence_snapshots WHERE memory_digest = ?")
      .get(memory.digest) as EvidenceSnapshotRow | undefined;
    if (!snapshotRow) {
      throw new Error("Memory lineage member has no durable Tribunal evidence snapshot.");
    }
    const snapshot = rowToEvidenceSnapshot(snapshotRow);
    const chronology = this.#db
      .prepare("SELECT staged_at FROM memories WHERE digest = ?")
      .get(memory.digest) as { staged_at: string } | undefined;
    if (!chronology) throw new Error("Memory lineage member lost its staging chronology.");
    assertTimestamp(chronology.staged_at, "memory lineage stagedAt");
    const history = this.evidenceHistory(memory.digest);
    if (history.some(
      (entry) => Date.parse(entry.observation.observedAt) <= Date.parse(chronology.staged_at),
    )) {
      throw new Error("Memory lineage member contains non-later Tribunal evidence.");
    }
    const origins = this.#originIdentities(memory);
    if (history.some((entry) => this.#isOriginObservation(origins, entry.observation))) {
      throw new Error("Memory lineage member contains evidence from its own origin.");
    }
    const derived = deriveEvidence(memory, history);
    if (
      snapshot.memoryDigest !== memory.digest
      || snapshot.evidenceDigest !== decision.tribunalEvidenceDigest
      || snapshot.evidenceDigest !== derived.evidenceDigest
      || canonicalize(snapshot.observationDigests) !== canonicalize(derived.observationDigests)
      || canonicalize(snapshot.evidence as unknown as JsonValue)
        !== canonicalize(derived.evidence as unknown as JsonValue)
    ) {
      throw new Error(
        "Memory lineage member's snapshot does not match its durable observation ledger.",
      );
    }
    const rederived = adjudicateMemory(memory, derived.evidence, decision.decidedAt);
    if (
      rederived.decision !== "ADMIT"
      || canonicalize(rederived as unknown as JsonValue)
        !== canonicalize(decision as unknown as JsonValue)
    ) {
      throw new Error("Memory lineage member failed independent Tribunal re-adjudication.");
    }
    return Object.freeze({
      memoryDigest: memory.digest,
      decisionDigest: decision.decisionDigest,
      tribunalEvidenceDigest: decision.tribunalEvidenceDigest,
    });
  }

  #originIdentities(memory: StoredMemory): MemoryOriginIdentities {
    const caseDigests = new Set<string>();
    const runDigests = new Set<string>();
    const legacyCaseDigests = new Set<string>();
    const add = (origin: StoredMemory): void => {
      const caseDigest = origin.candidate.caseDigest;
      if (!caseDigest) return;
      caseDigests.add(caseDigest);
      const fingerprint = memoryReproducibilityFingerprint(origin.candidate);
      if (fingerprint) runDigests.add(fingerprint.origin.runDigest);
      else legacyCaseDigests.add(caseDigest);
    };
    add(memory);
    if (memory.candidate.scope === "SELF") {
      const lookup = this.#db.prepare("SELECT * FROM memories WHERE digest = ?");
      for (const sourceDigest of memory.candidate.sourceMemoryDigests) {
        const sourceRow = lookup.get(sourceDigest) as MemoryRow | undefined;
        if (!sourceRow)
          throw new Error(
            "SELF memory evidence requires locally attributable source-memory origins.",
          );
        const source = rowToMemory(sourceRow);
        if (!source.candidate.caseDigest || !isSha256Digest(source.candidate.caseDigest)) {
          throw new Error(
            "SELF memory evidence requires locally attributable source-memory origins.",
          );
        }
        add(source);
      }
    }
    if (caseDigests.size === 0)
      throw new Error("Reproduction evidence requires an origin Case digest on the staged memory.");
    return Object.freeze({ caseDigests, runDigests, legacyCaseDigests });
  }

  #isOriginObservation(
    origins: MemoryOriginIdentities,
    observation: MemoryEvidenceObservation,
  ): boolean {
    if (observation.sourceRunDigest) {
      return origins.runDigests.has(observation.sourceRunDigest)
        || origins.legacyCaseDigests.has(observation.sourceCaseDigest);
    }
    return origins.caseDigests.has(observation.sourceCaseDigest);
  }

  #insertDecision(decision: MemoryDecision) {
    if (decision.protocol !== "jevyr.memory-decision/1")
      throw new TypeError("Unsupported memory decision protocol.");
    if (!isSha256Digest(decision.memoryDigest))
      throw new TypeError("Decision memoryDigest must be a SHA-256 digest.");
    if (!isSha256Digest(decision.decisionDigest))
      throw new TypeError("decisionDigest must be a SHA-256 digest.");
    if (decision.decision === "PENDING")
      throw new Error("PENDING is provisional and cannot seal the durable evidence ledger.");
    if (
      decision.tribunalEvidenceDigest !== undefined &&
      !isSha256Digest(decision.tribunalEvidenceDigest)
    )
      throw new TypeError("tribunalEvidenceDigest must be a SHA-256 digest.");
    if (
      !Array.isArray(decision.reasons) ||
      !decision.reasons.every((reason) => typeof reason === "string")
    )
      throw new TypeError("Decision reasons must be strings.");
    const unsigned = {
      protocol: decision.protocol,
      memoryDigest: decision.memoryDigest,
      decision: decision.decision,
      reasons: decision.reasons,
      decidedAt: decision.decidedAt,
      ...(decision.tribunalEvidenceDigest
        ? { tribunalEvidenceDigest: decision.tribunalEvidenceDigest }
        : {}),
    };
    if (digestJson(unsigned as unknown as JsonValue) !== decision.decisionDigest)
      throw new Error("Memory decision digest does not match its payload.");
    if (decision.decision === "ADMIT") {
      if (!decision.tribunalEvidenceDigest)
        throw new Error("ADMIT requires a derived Tribunal evidence digest.");
      const snapshotRow = this.#db
        .prepare(
          `SELECT * FROM memory_evidence_snapshots
            WHERE memory_digest = ? AND evidence_digest = ?`,
        )
        .get(decision.memoryDigest, decision.tribunalEvidenceDigest) as
        | EvidenceSnapshotRow
        | undefined;
      if (!snapshotRow)
        throw new Error("ADMIT requires a durable snapshot derived from stored observations.");
      const snapshot = rowToEvidenceSnapshot(snapshotRow);
      const current = this.deriveTribunalEvidence(decision.memoryDigest);
      if (
        snapshot.evidenceDigest !== current.evidenceDigest ||
        canonicalize(snapshot.observationDigests) !== canonicalize(current.observationDigests)
      )
        throw new Error("ADMIT evidence snapshot does not match the durable observation ledger.");
    }
    this.#db
      .prepare(
        `INSERT INTO memory_decisions
          (decision_digest, memory_digest, decision, reasons_json, decided_at,
           tribunal_evidence_digest)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.decisionDigest,
        decision.memoryDigest,
        decision.decision,
        canonicalize(decision.reasons),
        decision.decidedAt,
        decision.tribunalEvidenceDigest ?? null,
      );
  }

  stage(candidate: MemoryCandidate, stagedAt: string): StoredMemory {
    assertTimestamp(stagedAt, "stagedAt");
    const memory = stageMemory(candidate);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO memories
          (digest, protocol, scope, kind, abstract_summary, content_json,
           source_json, evidence_json, project_id, case_digest, supersedes, staged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.digest,
        memory.candidate.protocol,
        memory.candidate.scope,
        memory.candidate.kind,
        memory.candidate.abstractSummary,
        canonicalize(memory.candidate.content),
        canonicalize(memory.candidate.sourceMemoryDigests),
        canonicalize(memory.candidate.evidenceDigests),
        memory.candidate.projectId ?? null,
        memory.candidate.caseDigest ?? null,
        memory.candidate.supersedes ?? null,
        stagedAt,
      );
    const storedRow = this.#db
      .prepare("SELECT * FROM memories WHERE digest = ?")
      .get(memory.digest) as MemoryRow | undefined;
    if (!storedRow) throw new Error("Staged memory disappeared before verification.");
    const stored = rowToMemory(storedRow);
    if (
      storedRow.staged_at !== stagedAt
      || stageMemory(stored.candidate).digest !== memory.digest
      || canonicalize(stored.candidate as unknown as JsonValue)
        !== canonicalize(memory.candidate as unknown as JsonValue)
    ) {
      throw new Error("Existing staged memory does not match the exact candidate chronology.");
    }
    return stored;
  }

  appendEvidenceObservation(
    memoryDigest: string,
    observation: MemoryEvidenceObservation,
  ): StoredMemoryEvidenceObservation {
    assertMemoryEvidenceObservation(observation);
    const memory = this.#memory(memoryDigest);
    const chronology = this.#db
      .prepare("SELECT staged_at FROM memories WHERE digest = ?")
      .get(memoryDigest) as { staged_at: string } | undefined;
    if (
      !chronology ||
      Date.parse(observation.observedAt) <= Date.parse(chronology.staged_at)
    ) {
      throw new Error("Tribunal evidence must be observed after the memory was staged.");
    }
    const origins = this.#originIdentities(memory);
    if (this.#isOriginObservation(origins, observation))
      throw new Error("A memory's origin Case execution cannot observe its own reproduction.");
    const decided = this.#db
      .prepare("SELECT 1 AS present FROM memory_decisions WHERE memory_digest = ?")
      .get(memoryDigest) as { present: number } | undefined;
    if (decided) throw new Error("The evidence ledger is sealed by its Tribunal decision.");
    const count = this.#db
      .prepare("SELECT COUNT(*) AS count FROM memory_evidence_observations WHERE memory_digest = ?")
      .get(memoryDigest) as { count: number };
    if (count.count >= MAX_MEMORY_EVIDENCE_OBSERVATIONS)
      throw new RangeError("Memory evidence observation limit exceeded.");

    const observationDigest = memoryEvidenceObservationDigest(memoryDigest, observation);
    const priorIdentity = this.#db
      .prepare(
        `SELECT observation_digest FROM memory_evidence_observations
          WHERE observation_id = ?`,
      )
      .get(observation.observationId) as { observation_digest: string } | undefined;
    if (priorIdentity) {
      if (priorIdentity.observation_digest === observationDigest)
        throw new Error("Duplicate evidence observation identity.");
      throw new Error("Conflicting evidence observation identity.");
    }
    const priorDigest = this.#db
      .prepare(
        `SELECT observation_id FROM memory_evidence_observations
          WHERE observation_digest = ?`,
      )
      .get(observationDigest) as { observation_id: string } | undefined;
    if (priorDigest) throw new Error("Duplicate evidence observation payload.");
    const priorEvidence = this.#db
      .prepare(
        `SELECT observation_id, kind, source_case_digest, source_run_digest
           FROM memory_evidence_observations
          WHERE memory_digest = ? AND evidence_digest = ?`,
      )
      .get(memoryDigest, observation.evidenceDigest) as
      | {
          observation_id: string;
          kind: string;
          source_case_digest: string;
          source_run_digest: string | null;
        }
      | undefined;
    if (priorEvidence) {
      if (
        priorEvidence.kind === observation.kind &&
        priorEvidence.source_case_digest === observation.sourceCaseDigest &&
        (priorEvidence.source_run_digest ?? null) === (observation.sourceRunDigest ?? null)
      )
        throw new Error("Duplicate evidence identity under another observation id.");
      throw new Error("Conflicting evidence identity.");
    }

    const normalized = normalizeObservation(observation);
    const result = this.#db
      .prepare(
        `INSERT INTO memory_evidence_observations
          (observation_id, observation_digest, memory_digest, protocol, kind,
           source_case_digest, source_run_digest, evidence_digest, passed, observed_at,
           observation_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.observationId,
        observationDigest,
        memoryDigest,
        normalized.protocol,
        normalized.kind,
        normalized.sourceCaseDigest,
        normalized.sourceRunDigest ?? null,
        normalized.evidenceDigest,
        "passed" in normalized ? (normalized.passed ? 1 : 0) : null,
        normalized.observedAt,
        canonicalize(normalized as unknown as JsonValue),
      );
    const sequence = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error("SQLite returned an invalid evidence sequence.");
    return Object.freeze({
      sequence,
      observationDigest,
      memoryDigest,
      observation: normalized,
    });
  }

  evidenceHistory(memoryDigest: string): readonly StoredMemoryEvidenceObservation[] {
    this.#memory(memoryDigest);
    const rows = this.#db
      .prepare(
        `SELECT * FROM memory_evidence_observations
          WHERE memory_digest = ? ORDER BY sequence ASC`,
      )
      .all(memoryDigest) as unknown as ObservationRow[];
    return Object.freeze(rows.map(rowToObservation));
  }

  deriveTribunalEvidence(memoryDigest: string): DerivedTribunalEvidence {
    const memory = this.#memory(memoryDigest);
    const origins = this.#originIdentities(memory);
    const history = this.evidenceHistory(memoryDigest);
    if (history.some((item) => this.#isOriginObservation(origins, item.observation)))
      throw new Error("A memory's origin Case execution cannot supply Tribunal evidence.");
    return deriveEvidence(memory, history);
  }

  adjudicateEvidence(memoryDigest: string, decidedAt: string): EvidenceAdjudication {
    assertTimestamp(decidedAt, "decidedAt");
    const memory = this.#memory(memoryDigest);
    const evidence = this.deriveTribunalEvidence(memoryDigest);
    const decision = adjudicateMemory(memory, evidence.evidence, decidedAt);
    if (decision.decision === "PENDING") {
      return Object.freeze({ memory, evidence, decision });
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO memory_evidence_snapshots
            (evidence_digest, memory_digest, protocol, observation_digests_json,
             evidence_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          evidence.evidenceDigest,
          memoryDigest,
          evidence.protocol,
          canonicalize(evidence.observationDigests),
          canonicalize(evidence.evidence as unknown as JsonValue),
        );
      this.#insertDecision(decision);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return Object.freeze({ memory, evidence, decision });
  }

  /**
   * Atomically append one authenticated comparison's observations and run the
   * Tribunal over the resulting durable ledger. Exact retries are successful,
   * including after a terminal decision, but only after the existing snapshot
   * and decision are independently re-derived and compared.
   */
  reconcileEvidenceBatch(
    memoryDigest: string,
    observations: readonly MemoryEvidenceObservation[],
    decidedAt: string,
  ): ReconciledMemoryEvidence {
    assertTimestamp(decidedAt, "decidedAt");
    if (!Array.isArray(observations) || observations.length < 1 || observations.length > 16) {
      throw new RangeError("Evidence reconciliation requires 1-16 observations.");
    }
    observations.forEach(assertMemoryEvidenceObservation);
    const inputIds = observations.map((observation) => observation.observationId);
    if (new Set(inputIds).size !== inputIds.length) {
      throw new Error("Evidence reconciliation contains duplicate observation identities.");
    }

    let transaction = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      transaction = true;
      const memory = this.#memory(memoryDigest);
      const chronology = this.#db
        .prepare("SELECT staged_at FROM memories WHERE digest = ?")
        .get(memoryDigest) as { staged_at: string } | undefined;
      if (!chronology) throw new Error("Unknown staged memory.");
      const origins = this.#originIdentities(memory);
      for (const observation of observations) {
        if (Date.parse(observation.observedAt) <= Date.parse(chronology.staged_at)) {
          throw new Error("Tribunal evidence must be observed after the memory was staged.");
        }
        if (this.#isOriginObservation(origins, observation)) {
          throw new Error("A memory's origin Case execution cannot observe its own reproduction.");
        }
      }

      const existingDecisionRow = this.#db
        .prepare("SELECT * FROM memory_decisions WHERE memory_digest = ?")
        .get(memoryDigest) as DecisionRow | undefined;
      let count = (this.#db
        .prepare("SELECT COUNT(*) AS count FROM memory_evidence_observations WHERE memory_digest = ?")
        .get(memoryDigest) as { count: number }).count;
      let insertedObservations = 0;
      const storedRequested: StoredMemoryEvidenceObservation[] = [];

      for (const input of observations) {
        const normalized = normalizeObservation(input);
        const observationDigest = memoryEvidenceObservationDigest(memoryDigest, normalized);
        const byId = this.#db
          .prepare("SELECT * FROM memory_evidence_observations WHERE observation_id = ?")
          .get(normalized.observationId) as ObservationRow | undefined;
        if (byId) {
          const stored = rowToObservation(byId);
          if (stored.memoryDigest !== memoryDigest || stored.observationDigest !== observationDigest) {
            throw new Error("Conflicting evidence observation identity.");
          }
          storedRequested.push(stored);
          continue;
        }
        if (existingDecisionRow) {
          throw new Error("The evidence ledger is sealed by a different Tribunal observation set.");
        }
        const byDigest = this.#db
          .prepare("SELECT * FROM memory_evidence_observations WHERE observation_digest = ?")
          .get(observationDigest) as ObservationRow | undefined;
        if (byDigest) throw new Error("Conflicting evidence observation digest.");
        const byEvidence = this.#db
          .prepare(
            `SELECT * FROM memory_evidence_observations
              WHERE memory_digest = ? AND evidence_digest = ?`,
          )
          .get(memoryDigest, normalized.evidenceDigest) as ObservationRow | undefined;
        if (byEvidence) throw new Error("Conflicting evidence identity.");
        if (count >= MAX_MEMORY_EVIDENCE_OBSERVATIONS) {
          throw new RangeError("Memory evidence observation limit exceeded.");
        }
        const result = this.#db
          .prepare(
            `INSERT INTO memory_evidence_observations
              (observation_id, observation_digest, memory_digest, protocol, kind,
                source_case_digest, source_run_digest, evidence_digest, passed, observed_at,
                observation_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            normalized.observationId,
            observationDigest,
            memoryDigest,
            normalized.protocol,
            normalized.kind,
            normalized.sourceCaseDigest,
            normalized.sourceRunDigest ?? null,
            normalized.evidenceDigest,
            "passed" in normalized ? (normalized.passed ? 1 : 0) : null,
            normalized.observedAt,
            canonicalize(normalized as unknown as JsonValue),
          );
        const sequence = Number(result.lastInsertRowid);
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
          throw new Error("SQLite returned an invalid evidence sequence.");
        }
        storedRequested.push(Object.freeze({
          sequence,
          observationDigest,
          memoryDigest,
          observation: Object.freeze(normalized),
        }));
        count += 1;
        insertedObservations += 1;
      }

      const evidence = deriveEvidence(memory, this.evidenceHistory(memoryDigest));
      let decision: MemoryDecision;
      if (existingDecisionRow) {
        decision = rowToDecision(existingDecisionRow);
        const snapshotRow = this.#db
          .prepare("SELECT * FROM memory_evidence_snapshots WHERE memory_digest = ?")
          .get(memoryDigest) as EvidenceSnapshotRow | undefined;
        if (!snapshotRow) {
          throw new Error("Sealed Tribunal decision has no durable evidence snapshot.");
        }
        const snapshot = rowToEvidenceSnapshot(snapshotRow);
        if (
          snapshot.evidenceDigest !== evidence.evidenceDigest
          || canonicalize(snapshot.observationDigests) !== canonicalize(evidence.observationDigests)
        ) {
          throw new Error("Sealed Tribunal snapshot does not match the durable observation ledger.");
        }
        const rederived = adjudicateMemory(memory, evidence.evidence, decision.decidedAt);
        if (
          rederived.decision === "PENDING"
          || canonicalize(rederived as unknown as JsonValue) !== canonicalize(decision as unknown as JsonValue)
        ) {
          throw new Error("Sealed Tribunal decision does not match independent re-adjudication.");
        }
      } else {
        decision = adjudicateMemory(memory, evidence.evidence, decidedAt);
        if (decision.decision !== "PENDING") {
          this.#db
            .prepare(
              `INSERT INTO memory_evidence_snapshots
                (evidence_digest, memory_digest, protocol, observation_digests_json,
                 evidence_json)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              evidence.evidenceDigest,
              memoryDigest,
              evidence.protocol,
              canonicalize(evidence.observationDigests),
              canonicalize(evidence.evidence as unknown as JsonValue),
            );
          this.#insertDecision(decision);
        }
      }

      this.#db.exec("COMMIT");
      transaction = false;
      return Object.freeze({
        memory,
        evidence,
        decision,
        observations: Object.freeze(storedRequested),
        insertedObservations,
      });
    } catch (error) {
      if (transaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  decide(decision: MemoryDecision) {
    assertTimestamp(decision.decidedAt, "decidedAt");
    const exists = this.#db
      .prepare("SELECT 1 AS present FROM memories WHERE digest = ?")
      .get(decision.memoryDigest) as { present: number } | undefined;
    if (!exists) throw new Error("Cannot decide an unknown staged memory.");
    this.#insertDecision(decision);
  }

  submit(
    candidate: MemoryCandidate,
    evidence: TribunalEvidence,
    stagedAt: string,
    decidedAt = stagedAt,
  ) {
    const memory = this.stage(candidate, stagedAt);
    const decision = adjudicateMemory(memory, evidence, decidedAt);
    if (decision.decision !== "PENDING") this.decide(decision);
    return Object.freeze({ memory, decision });
  }

  /** Stable, content-verified project ledger view used by later-Case reconciliation. */
  projectMemoryStates(projectId: string): readonly ProjectMemoryState[] {
    if (typeof projectId !== "string" || projectId.length < 1 || projectId.length > 256) {
      throw new TypeError("projectId must contain 1-256 characters.");
    }
    const rows = this.#db
      .prepare("SELECT * FROM memories WHERE project_id = ? ORDER BY staged_at, digest")
      .all(projectId) as unknown as MemoryRow[];
    const decision = this.#db.prepare("SELECT * FROM memory_decisions WHERE memory_digest = ?");
    return Object.freeze(rows.map((row): ProjectMemoryState => {
      assertTimestamp(row.staged_at, "stagedAt");
      const memory = rowToMemory(row);
      if (stageMemory(memory.candidate).digest !== memory.digest) {
        throw new Error("Stored memory failed digest verification.");
      }
      const decided = decision.get(row.digest) as DecisionRow | undefined;
      return Object.freeze({
        memory,
        stagedAt: row.staged_at,
        ...(decided === undefined ? {} : { decision: rowToDecision(decided) }),
      });
    }));
  }

  /**
   * Reconstruct a complete, bounded transitive influence closure from durable
   * storage. Every member must be content-addressed, project-compatible, and
   * independently re-adjudicate to ADMIT from its exact observation snapshot.
   */
  verifiedMemoryLineage(
    projectId: string,
    rootMemoryDigests: readonly string[],
  ): VerifiedMemoryLineage {
    if (typeof projectId !== "string" || projectId.length < 1 || projectId.length > 256) {
      throw new TypeError("projectId must contain 1-256 characters.");
    }
    if (
      !Array.isArray(rootMemoryDigests)
      || rootMemoryDigests.length > 256
      || !rootMemoryDigests.every(isSha256Digest)
    ) {
      throw new TypeError("Memory lineage roots must be a bounded SHA-256 digest array.");
    }
    if (new Set(rootMemoryDigests).size !== rootMemoryDigests.length) {
      throw new TypeError("Memory lineage roots cannot contain duplicates.");
    }
    const roots = Object.freeze([...rootMemoryDigests]);
    const loaded = new Map<string, StoredMemory>();
    const visiting = new Set<string>();
    const verified = new Set<string>();
    const bindings = new Map<string, {
      readonly memoryDigest: string;
      readonly decisionDigest: string;
      readonly tribunalEvidenceDigest: string;
    }>();
    let transaction = false;
    try {
      this.#db.exec("BEGIN");
      transaction = true;
      const visit = (memoryDigest: string, requiredProjectId: string | undefined): void => {
        if (visiting.has(memoryDigest)) {
          throw new Error("Memory lineage contains a cycle.");
        }
        let memory = loaded.get(memoryDigest);
        if (!memory) {
          if (loaded.size >= MAX_VERIFIED_MEMORY_LINEAGE) {
            throw new RangeError(
              `Memory lineage exceeds ${MAX_VERIFIED_MEMORY_LINEAGE} unique members.`,
            );
          }
          memory = this.#lineageMemory(memoryDigest);
          loaded.set(memoryDigest, memory);
        }
        if (
          memory.candidate.scope !== "SELF"
          && requiredProjectId !== undefined
          && memory.candidate.projectId !== requiredProjectId
        ) {
          throw new Error("Memory lineage crosses an incompatible project boundary.");
        }
        if (verified.has(memoryDigest)) return;
        visiting.add(memoryDigest);
        const descendantProjectId = memory.candidate.scope === "SELF"
          ? undefined
          : memory.candidate.projectId;
        for (const sourceDigest of memory.candidate.sourceMemoryDigests) {
          visit(sourceDigest, descendantProjectId);
        }
        visiting.delete(memoryDigest);
        bindings.set(memoryDigest, this.#verifiedAdmissionBinding(memory));
        verified.add(memoryDigest);
      };
      for (const rootDigest of roots) visit(rootDigest, projectId);

      const memoryDigests = Object.freeze(
        [...verified].sort((left, right) => left.localeCompare(right)),
      );
      const admissionBindings = [...bindings.values()]
        .sort((left, right) => left.memoryDigest.localeCompare(right.memoryDigest));
      const admissionBindingDigest = digestJson({
        protocol: "jevyr.memory-lineage-admission-bindings/1",
        bindings: admissionBindings,
      } as unknown as JsonValue);
      const unsigned = {
        protocol: MEMORY_LINEAGE_PROTOCOL,
        projectId,
        rootMemoryDigests: roots,
        memoryDigests,
        admissionBindingDigest,
      } as const;
      const lineage: VerifiedMemoryLineage = Object.freeze({
        ...unsigned,
        lineageDigest: digestJson(unsigned as unknown as JsonValue),
      });
      this.#db.exec("COMMIT");
      transaction = false;
      VERIFIED_MEMORY_LINEAGES.add(lineage);
      return lineage;
    } catch (error) {
      if (transaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  retrieve(request: RetrievalRequest): readonly RetrievedMemory[] {
    if (!RETRIEVAL_STAGES.has(request.stage)) return Object.freeze([]);
    if (!request.projectId.trim() || !isSha256Digest(request.caseDigest))
      throw new TypeError("Retrieval requires a project id and case digest.");
    const hasIntent = request.intentContractDigest !== undefined;
    const hasMaterial = request.subjectMaterialCaptureDigest !== undefined;
    if (hasIntent !== hasMaterial) {
      throw new TypeError("Exact-task memory retrieval requires both intent and subject-material digests.");
    }
    if (
      (hasIntent && !isSha256Digest(request.intentContractDigest as string))
      || (hasMaterial && !isSha256Digest(request.subjectMaterialCaptureDigest as string))
    ) {
      throw new TypeError("Exact-task memory retrieval digests must be SHA-256 digests.");
    }
    const limit = Math.max(1, Math.min(100, request.limit ?? 12));
    const rows = this.#db
      .prepare(
        `SELECT m.*
           FROM memories m
           JOIN memory_decisions d ON d.memory_digest = m.digest
           JOIN memory_evidence_snapshots s
             ON s.memory_digest = m.digest
            AND s.evidence_digest = d.tribunal_evidence_digest
      LEFT JOIN memory_tombstones t ON t.target_digest = m.digest
          WHERE d.decision = 'ADMIT'
            AND t.target_digest IS NULL
            AND (
              (m.scope = 'CASE' AND m.case_digest = ?)
              OR (m.scope = 'PROJECT' AND m.project_id = ?)
              OR (m.scope = 'SELF' AND ? = 1)
            )
       ORDER BY m.digest ASC`,
      )
      .all(
        request.caseDigest,
        request.projectId,
        request.includeSelfArchive ? 1 : 0,
      ) as unknown as MemoryRow[];

    const ranked = rows
      .map(rowToMemory)
      .filter((memory) => {
        const fingerprint = memoryReproducibilityFingerprint(memory.candidate);
        if (!fingerprint) return true;
        return hasIntent
          && hasMaterial
          && fingerprint.origin.caseDigest === request.caseDigest
          && fingerprint.task.intentContractDigest === request.intentContractDigest
          && fingerprint.task.subjectMaterialCaptureDigest === request.subjectMaterialCaptureDigest;
      })
      .map((memory): RetrievedMemory => {
        const scopeWeight =
          memory.candidate.scope === "CASE"
            ? 0.18
            : memory.candidate.scope === "PROJECT"
              ? 0.12
              : 0.06;
        const similarity = descriptorSimilarity(request.descriptor, memory.candidate.content);
        return {
          memoryDigest: memory.digest,
          scope: memory.candidate.scope,
          kind: memory.candidate.kind,
          abstractSummary: memory.candidate.abstractSummary,
          content: structuredClone(memory.candidate.content),
          weight: Math.min(0.2, scopeWeight * (0.5 + similarity * 0.5)),
          influence: influenceFor(memory.candidate.kind),
        };
      })
      .sort((left, right) => {
        if (left.weight !== right.weight) return right.weight - left.weight;
        return left.memoryDigest.localeCompare(right.memoryDigest);
      })
      .slice(0, limit);
    return Object.freeze(ranked);
  }

  recordInfluence(influence: RecordedInfluence) {
    if (!RETRIEVAL_STAGES.has(influence.stage))
      throw new Error("Memory cannot influence the amnesic first wave.");
    if (!Number.isFinite(influence.weight) || influence.weight < 0 || influence.weight > 0.2)
      throw new RangeError("Memory influence weight must be in [0, 0.2].");
    if (!isSha256Digest(influence.caseDigest))
      throw new TypeError("Influence caseDigest must be a SHA-256 digest.");
    assertTimestamp(influence.observedAt, "observedAt");
    const admitted = this.#db
      .prepare(
        `SELECT 1 AS present
           FROM memories m
           JOIN memory_decisions d ON d.memory_digest = m.digest
           JOIN memory_evidence_snapshots s
             ON s.memory_digest = m.digest
            AND s.evidence_digest = d.tribunal_evidence_digest
      LEFT JOIN memory_tombstones t ON t.target_digest = m.digest
          WHERE m.digest = ? AND d.decision = 'ADMIT' AND t.target_digest IS NULL`,
      )
      .get(influence.memoryDigest) as { present: number } | undefined;
    if (!admitted) throw new Error("Only admitted, non-tombstoned memory can influence a Case.");
    this.#db
      .prepare(
        `INSERT INTO memory_influences
          (case_digest, memory_digest, stage, weight, influence, summary, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        influence.caseDigest,
        influence.memoryDigest,
        influence.stage,
        influence.weight,
        influence.influence,
        influence.summary,
        influence.observedAt,
      );
  }

  tombstone(targetDigest: string, evidenceDigest: string, tombstonedAt: string) {
    if (!isSha256Digest(targetDigest) || !isSha256Digest(evidenceDigest))
      throw new TypeError("Tombstones require target and evidence SHA-256 digests.");
    assertTimestamp(tombstonedAt, "tombstonedAt");
    this.#db
      .prepare(
        `INSERT INTO memory_tombstones
          (target_digest, evidence_digest, tombstoned_at)
         VALUES (?, ?, ?)`,
      )
      .run(targetDigest, evidenceDigest, tombstonedAt);
  }

  exportProject(projectId: string): MemoryExport {
    const memoryRows = this.#db
      .prepare("SELECT * FROM memories WHERE project_id = ? ORDER BY digest")
      .all(projectId) as unknown as MemoryRow[];
    const digests = new Set(memoryRows.map((row) => row.digest));
    const allDecisions = this.#db
      .prepare("SELECT * FROM memory_decisions ORDER BY id")
      .all() as unknown as DecisionRow[];
    const allObservations = this.#db
      .prepare("SELECT * FROM memory_evidence_observations ORDER BY sequence")
      .all() as unknown as ObservationRow[];
    const allEvidenceSnapshots = this.#db
      .prepare("SELECT * FROM memory_evidence_snapshots ORDER BY evidence_digest")
      .all() as unknown as EvidenceSnapshotRow[];
    const allInfluences = this.#db
      .prepare("SELECT * FROM memory_influences ORDER BY id")
      .all() as unknown as InfluenceRow[];
    const allTombstones = this.#db
      .prepare(
        "SELECT target_digest, evidence_digest, tombstoned_at FROM memory_tombstones ORDER BY id",
      )
      .all() as unknown as {
      target_digest: string;
      evidence_digest: string;
      tombstoned_at: string;
    }[];
    return Object.freeze({
      records: Object.freeze(memoryRows.map(rowToMemory)),
      decisions: Object.freeze(
        allDecisions.filter((row) => digests.has(row.memory_digest)).map(rowToDecision),
      ),
      observations: Object.freeze(
        allObservations.filter((row) => digests.has(row.memory_digest)).map(rowToObservation),
      ),
      evidenceSnapshots: Object.freeze(
        allEvidenceSnapshots
          .filter((row) => digests.has(row.memory_digest))
          .map(rowToEvidenceSnapshot),
      ),
      influences: Object.freeze(
        allInfluences
          .filter((row) => digests.has(row.memory_digest))
          .map((row) => ({
            caseDigest: row.case_digest,
            memoryDigest: row.memory_digest,
            stage: row.stage,
            weight: row.weight,
            influence: row.influence,
            summary: row.summary,
            observedAt: row.observed_at,
          })),
      ),
      tombstones: Object.freeze(
        allTombstones
          .filter((row) => digests.has(row.target_digest))
          .map((row) => ({
            targetDigest: row.target_digest,
            evidenceDigest: row.evidence_digest,
            tombstonedAt: row.tombstoned_at,
          })),
      ),
    });
  }

  purgeProject(projectId: string) {
    const projectRows = this.#db
      .prepare("SELECT digest FROM memories WHERE project_id = ?")
      .all(projectId) as unknown as { digest: string }[];
    const projectDigests = new Set(projectRows.map((row) => row.digest));
    const selfRows = this.#db
      .prepare("SELECT digest, source_json FROM memories WHERE scope = 'SELF'")
      .all() as unknown as { digest: string; source_json: string }[];
    const derivedSelf = selfRows
      .filter((row) =>
        parseStoredDigestArray(
          row.source_json,
          "Stored SELF memory source lineage",
        ).some((digest) => projectDigests.has(digest)),
      )
      .map((row) => row.digest);
    const targets = [...projectDigests, ...derivedSelf];
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.#db.prepare("DELETE FROM memories WHERE digest = ?");
      for (const digest of targets) remove.run(digest);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return Object.freeze({
      removedProjectRecords: projectDigests.size,
      removedDerivedSelfRecords: derivedSelf.length,
    });
  }

  close() {
    this.#db.close();
  }
}
