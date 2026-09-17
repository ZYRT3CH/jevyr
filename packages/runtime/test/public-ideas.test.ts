import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CaseEvent, EventKind } from "@jevyr/protocol";
import {
  CaseRepository,
  DEFAULT_SEARCH_PROFILE,
  FileEventHub,
  JevyrOrchestrator,
  PUBLIC_IDEA_MEDIA_TYPE,
  PUBLIC_IDEA_PROTOCOL,
  SealedForgeAdapter,
  encodePublicIdea,
  type MindAdapter,
  type MindRequest,
  type ProbeResult,
  type PublicContribution,
  type RuntimeEventDraft,
} from "../src/index.js";

const SUMMARY = "Let public infrastructure behave like a watershed instead of a queue.";
const BODY = "Give every unresolved civic need a bounded flow basin. Proposals merge only when their measurable downstream effects overlap, while incompatible ideas remain legible tributaries rather than being averaged into consensus.";

class PublicIdeaMind implements MindAdapter {
  readonly capability = Object.freeze({
    id: "mind.public-idea-fixture",
    kind: "mind" as const,
    displayName: "Public idea fixture",
    version: "1",
    transport: "in-process" as const,
    trust: "quarantined" as const,
    modalities: Object.freeze(["text" as const, "structured-data" as const]),
    network: "none" as const,
    canExecuteTools: false,
    deterministic: true,
  });
  private emitted = false;

  constructor(private readonly stage: MindRequest["stage"]) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    if (request.stage !== this.stage || this.emitted) return;
    this.emitted = true;
    const contribution = {
      id: "candidate_public_idea_fixture",
      kind: "candidate" as const,
      summary: SUMMARY,
      body: BODY,
      parentIds: ["model_supplied_parent_must_not_replace_nursery_genealogy"],
      tags: ["watershed", "civic-infrastructure"],
      feasibility: "BRIDGEABLE" as const,
      confidence: 0.99,
      evidenceRefs: ["model_asserted_evidence_has_no_artifact_authority"],
      hiddenReasoning: "must never cross the public-idea boundary",
    };
    yield contribution;
  }
}

class FailAfterCandidateHub extends FileEventHub {
  private candidateCommitted = false;
  private failed = false;

  override async append<K extends EventKind>(draft: RuntimeEventDraft<K>): Promise<CaseEvent<K>> {
    if (this.candidateCommitted && !this.failed && draft.kind === "search.status") {
      this.failed = true;
      throw new Error("fixture failure after candidate admission");
    }
    const event = await super.append(draft);
    if (draft.kind === "candidate.status" && draft.payload.status === "proposed") {
      this.candidateCommitted = true;
    }
    return event;
  }
}

test("public-idea encoding is exact, canonical, and excludes authority or hidden work", () => {
  const encoded = encodePublicIdea("candidate_exact", {
    summary: SUMMARY,
    body: BODY,
    parentIds: ["candidate_parent"],
    tags: ["watershed"],
    feasibility: "BRIDGEABLE",
  });
  assert.equal(encoded.size, encoded.bytes.byteLength);
  assert.match(encoded.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded.bytes)), {
    body: BODY,
    candidateId: "candidate_exact",
    feasibility: "BRIDGEABLE",
    parentIds: ["candidate_parent"],
    protocol: PUBLIC_IDEA_PROTOCOL,
    summary: SUMMARY,
    tags: ["watershed"],
  });
});

test("a nursery idea remains readable after a later Case failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-public-idea-failure-"));
  try {
    const repository = new CaseRepository(root);
    const events = new FailAfterCandidateHub(root);
    const orchestrator = new JevyrOrchestrator({
      repository,
      events,
      minds: [new PublicIdeaMind("diverge")],
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
    });
    const created = await orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "Invent one inspectable civic mechanism" },
    });
    const terminal = await orchestrator.waitForTerminal(created.caseId, 10_000);
    assert.equal(terminal.lifecycle, "invalid");

    const ledger = await events.read(created.caseId);
    const proposal = ledger.find((event) => event.kind === "candidate.status" && event.payload.status === "proposed");
    assert.equal(proposal?.kind, "candidate.status");
    assert.equal(proposal?.payload.artifactDigests?.length, 1);
    const digest = proposal?.payload.artifactDigests?.[0];
    assert.match(digest ?? "", /^sha256:[a-f0-9]{64}$/u);

    const meta = (await repository.artifacts(created.caseId)).find((entry) => entry.digest === digest);
    assert.equal(meta?.mediaType, PUBLIC_IDEA_MEDIA_TYPE);
    const stored = meta === undefined ? undefined : await repository.artifact(created.caseId, meta.id);
    const idea = JSON.parse(stored?.data.toString("utf8") ?? "null") as Record<string, unknown>;
    assert.equal(idea.protocol, PUBLIC_IDEA_PROTOCOL);
    assert.equal(idea.candidateId, proposal?.payload.candidateId);
    assert.equal(idea.summary, SUMMARY);
    assert.equal(idea.body, BODY);
    assert.deepEqual(idea.parentIds, [], "nursery genealogy replaces model-supplied parent claims");
    assert.ok((idea.tags as string[]).includes("untrusted-hypothesis"));
    assert.ok((idea.tags as string[]).includes("not-assay-backed"));
    assert.equal(Object.hasOwn(idea, "confidence"), false);
    assert.equal(Object.hasOwn(idea, "evidenceRefs"), false);
    assert.equal(Object.hasOwn(idea, "hiddenReasoning"), false);
    assert.equal(Object.hasOwn(idea, "authority"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary candidate emission persists its public idea and respects the sealed artifact budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-public-idea-direct-"));
  try {
    const repository = new CaseRepository(root);
    const events = new FileEventHub(root);
    const orchestrator = new JevyrOrchestrator({
      repository,
      events,
      minds: [new PublicIdeaMind("interpret")],
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
    });
    const created = await orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "Retain one directly emitted idea" },
    });
    await orchestrator.waitForTerminal(created.caseId, 10_000);
    const proposal = (await events.read(created.caseId)).find((event) =>
      event.stage === "interpret" && event.kind === "candidate.status" && event.payload.status === "proposed");
    assert.equal(proposal?.kind, "candidate.status");
    const digest = proposal?.payload.artifactDigests?.[0];
    const meta = (await repository.artifacts(created.caseId)).find((entry) => entry.digest === digest);
    assert.equal(meta?.mediaType, PUBLIC_IDEA_MEDIA_TYPE);
    assert.ok((meta?.size ?? 0) <= DEFAULT_SEARCH_PROFILE.resources.maxArtifactBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
