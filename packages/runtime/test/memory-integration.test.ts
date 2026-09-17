import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MEMORY_CANDIDATE_MEDIA_TYPE, TemporalDeep } from "@jevyr/memory";
import { sha256Digest } from "@jevyr/protocol";
import {
  CaseRepository,
  DEFAULT_SEARCH_PROFILE,
  FileEventHub,
  JevyrOrchestrator,
  RuleMindAdapter,
  SealedForgeAdapter,
  type CapabilityCard,
  type MindAdapter,
  type MindRequest,
  type ProbeResult,
} from "../src/index.js";

class ExactOutcomeMind implements MindAdapter {
  readonly capability: CapabilityCard = Object.freeze({
    id: "mind.exact-outcome-fixture",
    kind: "mind",
    displayName: "Exact outcome fixture",
    version: "1",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: ["text", "structured-data"],
    network: "none",
    canExecuteTools: false,
    deterministic: true,
  });

  async probe(): Promise<ProbeResult> {
    return {
      available: true,
      observedAt: "2026-09-04T00:00:00.000Z",
      latencyMs: 0,
      version: "1",
      detail: "Fixed contributions for exact-outcome reconciliation tests.",
    };
  }

  async *run(request: MindRequest) {
    if (request.stage === "interpret") {
      yield {
        id: "exact_interpretation",
        kind: "interpretation" as const,
        summary: "Read the sealed task literally without adding semantic similarity.",
      };
      return;
    }
    if (request.stage === "diverge") {
      yield {
        id: "exact_candidate",
        kind: "candidate" as const,
        summary: "Use the same explicit deterministic discriminator mechanism.",
        feasibility: "BUILDABLE_NOW" as const,
        tags: ["exact-outcome-fixture"],
      };
      return;
    }
    if (request.stage === "recombine") {
      yield {
        id: "exact_recombination",
        kind: "candidate" as const,
        summary: "Retain the fixed deterministic discriminator mechanism.",
        feasibility: "BUILDABLE_NOW" as const,
        tags: ["exact-outcome-fixture"],
      };
      return;
    }
    if (request.stage === "challenge") {
      yield {
        id: "exact_challenge",
        kind: "challenge" as const,
        summary: "Require persisted execution evidence for the fixed mechanism.",
      };
      return;
    }
    yield {
      id: "exact_reflex",
      kind: "reflex" as const,
      summary: "Keep the fixed outcome unproven without authoritative execution.",
    };
  }
}

test("Temporal Deep enters only at recombination and leaves the current Case quarantined without adjudication", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-memory-runtime-"));
  const memory = new TemporalDeep(join(root, "memory.sqlite"));
  const projectId = "project-memory-integration";
  try {
    const admittedMemory = memory.stage(
      {
        protocol: "jevyr.memory/1",
        scope: "PROJECT",
        kind: "strategy",
        abstractSummary: "Invert the control boundary before selecting an assay subject.",
        content: { strategyFingerprint: "invert-control-boundary", descriptor: [0.2, 0.8] },
        sourceMemoryDigests: [],
        evidenceDigests: [sha256Digest("originating-evidence")],
        projectId,
        caseDigest: sha256Digest("origin-case"),
      },
      "2026-09-04T15:00:00.000Z",
    );
    memory.appendEvidenceObservation(admittedMemory.digest, {
      protocol: "jevyr.memory-evidence-observation/1",
      observationId: "reproduction-later-a",
      kind: "REPRODUCTION",
      sourceCaseDigest: sha256Digest("later-case-a"),
      evidenceDigest: sha256Digest("independent-reproduction-a"),
      observedAt: "2026-09-05T15:00:00.000Z",
    });
    memory.appendEvidenceObservation(admittedMemory.digest, {
      protocol: "jevyr.memory-evidence-observation/1",
      observationId: "reproduction-later-b",
      kind: "REPRODUCTION",
      sourceCaseDigest: sha256Digest("later-case-b"),
      evidenceDigest: sha256Digest("independent-reproduction-b"),
      observedAt: "2026-09-06T15:00:00.000Z",
    });
    memory.appendEvidenceObservation(admittedMemory.digest, {
      protocol: "jevyr.memory-evidence-observation/1",
      observationId: "contamination-review",
      kind: "CONTAMINATION",
      sourceCaseDigest: sha256Digest("later-review-case"),
      evidenceDigest: sha256Digest("contamination-check"),
      observedAt: "2026-09-07T15:00:00.000Z",
      passed: true,
    });
    const admitted = memory.adjudicateEvidence(
      admittedMemory.digest,
      "2026-09-08T15:00:00.000Z",
    );
    assert.equal(admitted.decision.decision, "ADMIT");

    const repository = new CaseRepository(join(root, "cases"));
    const events = new FileEventHub(join(root, "cases"));
    const orchestrator = new JevyrOrchestrator({
      repository,
      events,
      minds: [new RuleMindAdapter()],
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
      memory,
      memoryProjectId: projectId,
    });
    const created = await orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "Conceive a discriminator that tests its own control boundary." },
    });
    await orchestrator.waitForTerminal(created.caseId, 15_000);

    const ledger = await events.read(created.caseId);
    const influenceEvents = ledger.filter((event) => event.kind === "memory.influence");
    assert.equal(influenceEvents.length, 1);
    assert.equal(influenceEvents[0]?.stage, "recombine");
    assert.equal(influenceEvents[0]?.payload.memoryDigest, admitted.memory.digest);
    assert.ok((influenceEvents[0]?.payload.weight ?? 1) <= 0.2);
    assert.equal(ledger.some((event) => event.stage === "diverge" && event.kind === "memory.influence"), false);

    const record = await repository.record(created.caseId);
    assert.equal(record?.memoryInfluences.length, 1);
    assert.equal(record?.memoryInfluences[0]?.memoryDigest, admitted.memory.digest);

    const exported = memory.exportProject(projectId);
    assert.equal(exported.influences.length, 1);
    assert.equal(exported.records.length, 2);
    assert.equal(exported.decisions.length, 1);
    assert.equal(exported.decisions[0]?.decision, "ADMIT");
    const staging = ledger.find((event) => event.kind === "action.status"
      && event.stage === "memory_tribunal"
      && event.payload.actionType === "memory.staging");
    const commitment = ledger.find((event) => event.kind === "action.status"
      && event.stage === "crystallize"
      && event.payload.actionType === "memory.candidate.commitment");
    assert.equal(commitment?.actor.kind, "kernel");
    assert.equal(commitment?.payload.status, "completed");
    assert.equal(commitment?.payload.artifactDigests?.length, 1);
    assert.equal(record?.eventHeadDigest, commitment?.eventDigest);
    assert.ok((commitment?.sequence ?? Number.MAX_SAFE_INTEGER) < (staging?.sequence ?? 0));
    assert.equal(staging?.payload.status, "completed");
    assert.match(staging?.payload.summary ?? "", /not admitted memory/u);
    assert.equal(staging?.payload.artifactDigests?.length, 1);
    assert.equal(exported.records.some((entry) => entry.digest === staging?.payload.artifactDigests?.[0]), true);
    const stagedDigest = staging?.payload.artifactDigests?.[0];
    assert.ok(stagedDigest);
    const stagedArtifact = await repository.artifact(
      created.caseId,
      `artifact_${stagedDigest.slice("sha256:".length, "sha256:".length + 24)}`,
    );
    assert.equal(stagedArtifact?.meta.digest, stagedDigest);
    assert.equal(stagedArtifact?.meta.mediaType, MEMORY_CANDIDATE_MEDIA_TYPE);
    assert.deepEqual(
      JSON.parse(stagedArtifact?.data.toString("utf8") ?? "null"),
      exported.records.find((entry) => entry.digest === stagedDigest)?.candidate,
    );
    assert.deepEqual(
      exported.records.find((entry) => entry.digest === stagedDigest)?.candidate.evidenceDigests,
      [record?.verdict.evidenceDigest],
    );
    assert.equal(exported.observations.every((entry) => entry.memoryDigest === admitted.memory.digest), true);
  } finally {
    memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two distinct later signed Cases reconcile one exact outcome descriptor end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-memory-reproduction-"));
  const memory = new TemporalDeep(join(root, "memory.sqlite"));
  const projectId = "project-exact-reproduction";
  try {
    const repository = new CaseRepository(
      join(root, "cases"),
      undefined,
      undefined,
      {
        searchProfile: {
          ...DEFAULT_SEARCH_PROFILE,
          nursery: {
            minimumAttempts: 1,
            saturationWindow: 1,
            independentLineages: 1,
            challengeInterval: 1,
          },
          resources: {
            ...DEFAULT_SEARCH_PROFILE.resources,
            concurrentLineages: 1,
          },
        },
      },
    );
    const events = new FileEventHub(join(root, "cases"));
    const orchestrator = new JevyrOrchestrator({
      repository,
      events,
      minds: [new ExactOutcomeMind()],
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
      memory,
      memoryProjectId: projectId,
    });
    const caseIds: string[] = [];
    const stagedDigests: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await orchestrator.cast({
        protocol: "jevyr.case/1",
        case: { impulse: "Reconcile this exact signed outcome without semantic similarity." },
      });
      const terminal = await orchestrator.waitForTerminal(created.caseId, 15_000);
      assert.equal(terminal.lifecycle, "terminated");
      const ledger = await events.read(created.caseId);
      const staging = ledger.find((event) =>
        event.kind === "action.status"
        && event.payload.actionType === "memory.staging",
      );
      assert.equal(staging?.kind, "action.status");
      const stagedDigest = staging?.kind === "action.status"
        ? staging.payload.artifactDigests?.[0]
        : undefined;
      assert.ok(stagedDigest);
      caseIds.push(created.caseId);
      stagedDigests.push(stagedDigest);
      const reconciliation = ledger.find((event) =>
        event.kind === "action.status"
        && event.payload.actionType === "memory.reconciliation",
      );
      assert.equal(reconciliation?.kind, "action.status");
      if (reconciliation?.kind === "action.status") {
        assert.equal(reconciliation.payload.status, "completed");
        assert.equal(reconciliation.actor.kind, "archivist");
        assert.equal(reconciliation.payload.artifactDigests?.length, 1);
      }
      assert.ok((reconciliation?.sequence ?? 0) < (ledger.at(-1)?.sequence ?? 0));
      assert.equal(ledger.at(-1)?.kind, "stage.status");
    }

    const firstDigest = stagedDigests[0] as string;
    const secondDigest = stagedDigests[1] as string;
    const exported = memory.exportProject(projectId);
    const firstObservations = exported.observations.filter(
      (entry) => entry.memoryDigest === firstDigest,
    );
    assert.equal(
      firstObservations.filter((entry) => entry.observation.kind === "REPRODUCTION").length,
      2,
    );
    assert.equal(firstObservations.filter((entry) => entry.observation.kind === "CONTAMINATION").length, 2);
    const reproductionSourceRuns = firstObservations
      .filter((entry) => entry.observation.kind === "REPRODUCTION")
      .map((entry) => entry.observation.sourceRunDigest);
    assert.equal(new Set(reproductionSourceRuns).size, 2);
    const sourceRecords = await Promise.all(caseIds.slice(1).map(async (caseId) => await repository.record(caseId)));
    assert.deepEqual(
      [...reproductionSourceRuns].sort(),
      sourceRecords.map((record) => record?.runDigest as string).sort(),
    );
    assert.equal(new Set(sourceRecords.map((record) => record?.caseDigest)).size, 1);
    assert.equal(
      exported.decisions.find((decision) => decision.memoryDigest === firstDigest)?.decision,
      "ADMIT",
    );
    assert.equal(
      exported.decisions.some((decision) => decision.memoryDigest === secondDigest),
      false,
    );

    const thirdLedger = await events.read(caseIds[2] as string);
    const thirdReconciliation = thirdLedger.find((event) =>
      event.kind === "action.status"
      && event.payload.actionType === "memory.reconciliation",
    );
    assert.match(thirdReconciliation?.kind === "action.status" ? thirdReconciliation.payload.summary : "", /1 admitted/u);
    const thirdArtifacts = await repository.artifacts(caseIds[2] as string);
    const evidenceArtifacts = thirdArtifacts.filter(
      (artifact) => artifact.mediaType === "application/vnd.jevyr.memory-reconciliation+json",
    );
    assert.equal(evidenceArtifacts.length, 4);
    for (const artifact of evidenceArtifacts) {
      const stored = await repository.artifact(caseIds[2] as string, artifact.id);
      const value = JSON.parse(stored?.data.toString("utf8") ?? "null") as {
        protocol?: string;
        source?: { recordDigest?: string; recordEnvelopeDigest?: string };
        target?: { recordDigest?: string; recordEnvelopeDigest?: string };
        comparison?: {
          targetAncestryLineageDigest?: string;
          sourceInfluenceLineageDigest?: string;
          targetMemoryLineageDigests?: readonly string[];
          sourceMemoryLineageDigests?: readonly string[];
        };
      };
      assert.equal(value.protocol, "jevyr.memory-reconciliation-evidence/1");
      assert.ok(value.source?.recordDigest?.startsWith("sha256:"));
      assert.ok(value.source?.recordEnvelopeDigest?.startsWith("sha256:"));
      assert.ok(value.target?.recordDigest?.startsWith("sha256:"));
      assert.ok(value.target?.recordEnvelopeDigest?.startsWith("sha256:"));
      assert.ok(value.comparison?.targetAncestryLineageDigest?.startsWith("sha256:"));
      assert.ok(value.comparison?.sourceInfluenceLineageDigest?.startsWith("sha256:"));
      assert.equal(value.comparison?.targetMemoryLineageDigests?.length, 1);
      assert.deepEqual(value.comparison?.sourceMemoryLineageDigests, []);
    }

    // Model a crash after signed closure sidecars but before the terminal pair
    // and status cache became durable. Recovery must authenticate and restore
    // that exact root without adding events or duplicating Tribunal observations.
    const thirdCaseId = caseIds[2] as string;
    const observationsBeforeRecovery = memory.exportProject(projectId).observations;
    await Promise.all([
      rm(join(repository.dataDir, "cases", thirdCaseId, "terminal.json")),
      rm(join(repository.dataDir, "cases", thirdCaseId, "terminal.dsse.json")),
    ]);
    await repository.updateStatus(thirdCaseId, {
      lifecycle: "crystallized",
      stage: "sign",
      stageStatus: "completed",
      lastSequence: thirdLedger.length,
      headDigest: thirdLedger.at(-1)?.eventDigest ?? null,
    });
    const recovered = await orchestrator.recoverInterruptedCases();
    assert.equal(recovered.terminated, 1);
    assert.deepEqual(memory.exportProject(projectId).observations, observationsBeforeRecovery);
    const afterFirstRecovery = await events.read(thirdCaseId);
    assert.deepEqual(afterFirstRecovery, thirdLedger);

    await Promise.all([
      rm(join(repository.dataDir, "cases", thirdCaseId, "terminal.json")),
      rm(join(repository.dataDir, "cases", thirdCaseId, "terminal.dsse.json")),
    ]);
    await repository.updateStatus(thirdCaseId, {
      lifecycle: "crystallized",
      stage: "sign",
      stageStatus: "working",
      lastSequence: thirdLedger.length,
      headDigest: thirdLedger.at(-1)?.eventDigest ?? null,
    });
    await orchestrator.recoverInterruptedCases();
    assert.deepEqual(await events.read(thirdCaseId), afterFirstRecovery);
    assert.deepEqual(memory.exportProject(projectId).observations, observationsBeforeRecovery);

    const summaryArtifact = thirdArtifacts.find(
      (artifact) => artifact.mediaType === "application/vnd.jevyr.memory-reconciliation-summary+json",
    );
    assert.ok(summaryArtifact);
    await writeFile(
      join(repository.dataDir, "cases", thirdCaseId, "artifacts", `${summaryArtifact.id}.blob`),
      Buffer.alloc(summaryArtifact.size),
    );
    await Promise.all([
      rm(join(repository.dataDir, "cases", thirdCaseId, "terminal.json")),
      rm(join(repository.dataDir, "cases", thirdCaseId, "terminal.dsse.json")),
    ]);
    await repository.updateStatus(thirdCaseId, {
      lifecycle: "crystallized",
      stage: "sign",
      stageStatus: "working",
      lastSequence: thirdLedger.length,
      headDigest: thirdLedger.at(-1)?.eventDigest ?? null,
    });
    await assert.rejects(
      orchestrator.recoverInterruptedCases(),
      /content-address verification|summary artifact|collision or corrupt pre-existing blob/u,
    );
  } finally {
    memory.close();
    await rm(root, { recursive: true, force: true });
  }
});
