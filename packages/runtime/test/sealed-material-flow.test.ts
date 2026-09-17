import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import {
  CaseRepository,
  compileAssayFrontier,
  DEFAULT_SEARCH_PROFILE,
  decodeToolObservation,
  FileEventHub,
  JevyrOrchestrator,
  SealedForgeAdapter,
  TOOL_OBSERVATION_MEDIA_TYPE,
  loadJevyrIgnorePolicy,
  type MindAdapter,
  type MindRequest,
  type ProbeResult,
  type ToolAdapter,
  type ToolInvocation,
  type ToolObservation,
} from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

class RecordingMind implements MindAdapter {
  readonly requests: MindRequest[] = [];
  readonly capability;

  constructor(id: string, network: "none" | "provider") {
    this.capability = Object.freeze({
      id,
      kind: "mind" as const,
      displayName: id,
      version: "1",
      transport: "in-process" as const,
      trust: "quarantined" as const,
      modalities: Object.freeze(["text" as const]),
      network,
      canExecuteTools: false,
      deterministic: true,
    });
  }

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async *run(request: MindRequest): AsyncIterable<never> {
    this.requests.push(request);
  }
}

class RecordingForge implements ToolAdapter {
  readonly capability = Object.freeze({
    id: "tool.recording-forge",
    kind: "tool" as const,
    displayName: "Recording Forge",
    version: "1",
    transport: "in-process" as const,
    trust: "local-deterministic" as const,
    modalities: Object.freeze(["files" as const, "commands" as const]),
    network: "none" as const,
    canExecuteTools: true,
    deterministic: true,
  });
  calls = 0;
  sourceRoot?: string;
  subjectRoot?: string;
  observedText?: string;

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    this.calls += 1;
    this.sourceRoot = String(invocation.forgeMaterials?.protocol === "jevyr.forge-invocation-materials/1" ? invocation.forgeMaterials.candidate.sourceRoot : undefined);
    this.subjectRoot = String(invocation.forgeMaterials?.subjects.subjectRoot);
    this.observedText = await readFile(join(this.subjectRoot, "subject-0000", "input.txt"), "utf8");
    const now = new Date().toISOString();
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      summary: "The fixture inspected the sealed materialization.",
      startedAt: now,
      finishedAt: now,
      exitCode: 0,
      oracle: {
        execution: {
          state: "exited",
          mode: "trusted-host",
          command: String(invocation.args.command),
          args: (invocation.args.args ?? []) as readonly string[],
          shell: false,
          exitCode: 0,
          stdout: "",
          stderr: "",
          outputTruncated: false,
        },
      },
      metadata: measuredAccounting(invocation),
    };
  }
}

class BlueprintMind extends RecordingMind {
  private emitted = false;

  override async *run(request: MindRequest): AsyncIterable<import("../src/index.js").PublicContribution> {
    this.requests.push(request);
    if (request.stage !== "diverge" || this.emitted) return;
    this.emitted = true;
    yield Object.freeze({
      id: "candidate_finite_blueprint",
      kind: "candidate" as const,
      summary: "A finite candidate with inspectable source",
      feasibility: "BUILDABLE_NOW" as const,
      candidateBlueprintSource: {
        protocol: "jevyr.candidate-blueprint/1",
        files: [{ path: "app.txt", content: "candidate bytes\n" }],
        command: { executable: "untrusted-proposal", args: ["must-not-run"] },
      },
    });
  }
}

class BlueprintForge extends RecordingForge {
  observedCandidate?: string;
  observedSubject?: string;
  observedCommand?: string;

  override async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    this.calls += 1;
    this.sourceRoot = String(invocation.forgeMaterials?.protocol === "jevyr.forge-invocation-materials/1" ? invocation.forgeMaterials.candidate.sourceRoot : undefined);
    this.subjectRoot = String(invocation.forgeMaterials?.subjects.subjectRoot);
    this.observedCommand = String(invocation.args.command);
    this.observedCandidate = await readFile(join(this.sourceRoot, "app.txt"), "utf8");
    this.observedSubject = await readFile(
      join(this.subjectRoot, "subject-0000", "input.txt"),
      "utf8",
    );
    const now = new Date().toISOString();
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      summary: "The fixture inspected a finite blueprint and its sealed subject mount.",
      startedAt: now,
      finishedAt: now,
      exitCode: 0,
      oracle: {
        execution: {
          state: "exited",
          mode: "trusted-host",
          command: String(invocation.args.command),
          args: (invocation.args.args ?? []) as readonly string[],
          shell: false,
          exitCode: 0,
          stdout: "",
          stderr: "",
          outputTruncated: false,
        },
      },
      metadata: measuredAccounting(invocation),
    };
  }
}

function measuredAccounting(invocation: ToolInvocation): Readonly<Record<string, unknown>> {
  return Object.freeze({
    changedFiles: Object.freeze([]),
    resourceAccounting: Object.freeze({
      protocol: "jevyr.forge-resource-accounting/1",
      workspace: Object.freeze({
        byteCeiling: invocation.resourceLimits?.maxWritableBytes ?? 1_000_000,
        inodeCeiling: invocation.resourceLimits?.maxWritableInodes ?? 1_000,
        after: Object.freeze({ measurement: "MEASURED", complete: true, bytes: 1, inodes: 1 }),
      }),
      cpu: Object.freeze({ measurement: "DECLARED_ONLY", usedMillis: null }),
    }),
  });
}

async function fixture(): Promise<{ root: string; data: string; subject: string }> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-sealed-flow-"));
  temporary.push(root);
  const data = join(root, "data");
  const subject = join(root, "subject");
  await mkdir(subject);
  await writeFile(join(subject, "input.txt"), "sealed physical bytes\n", "utf8");
  return { root, data, subject };
}

test("every mind sees synthetic locators while provider scope withholds material only from remote minds", async () => {
  const { data, subject } = await fixture();
  const repository = new CaseRepository(data);
  const events = new FileEventHub(data);
  const local = new RecordingMind("mind.local", "none");
  const remote = new RecordingMind("mind.remote", "provider");
  const orchestrator = new JevyrOrchestrator({
    repository,
    events,
    minds: [remote, local],
    forge: new SealedForgeAdapter({ mode: "observe-only" }),
  });
  const created = await orchestrator.cast({
    protocol: "jevyr.case/1",
    case: {
      impulse: "Inspect the sealed subject without learning its source location",
      privacy: "provider_scoped",
      subjects: [{ id: "source", kind: "directory", locator: subject }],
    },
  });
  await orchestrator.waitForTerminal(created.caseId, 10_000);

  assert.ok(local.requests.length > 0);
  assert.ok(remote.requests.length > 0);
  assert.equal(local.requests.some((request) => request.subjectProjection?.files[0]?.text === "sealed physical bytes\n"), true);
  assert.equal(remote.requests.every((request) => request.subjectProjection === undefined), true);
  for (const request of [...local.requests, ...remote.requests]) {
    assert.equal(request.sealed.intent.subjects[0]?.locator.includes(subject), false);
    assert.match(request.sealed.intent.subjects[0]?.locator ?? "", /^jevyr:sealed-subject:source@sha256:/u);
    assert.equal(request.sealed.subjects[0]?.resolvedLocator, "jevyr:sealed-subject:source");
  }
});

test("Forge receives a fresh CAS reconstruction and never the policy plan's original sourceRoot", async () => {
  const { data, subject } = await fixture();
  const plan = Object.freeze({
    assayId: "sealed.cas-inspection",
    costUnits: 1,
    tool: "forge.command",
    args: Object.freeze({ command: "fixture", args: Object.freeze([]) }),
  });
  const frontier = compileAssayFrontier([plan], DEFAULT_SEARCH_PROFILE.resources);
  const ignorePolicy = await loadJevyrIgnorePolicy(subject);
  const repository = new CaseRepository(data, {
    protocol: "jevyr.effective-policy/1",
    kernel: "jevyr.deterministic-policy/1",
    assayFrontierDigest: frontier.digest,
    assayFrontier: frontier,
    candidateIgnorePolicyDigest: ignorePolicy.sourceDigest,
    candidateIgnorePolicy: {
      protocol: "jevyr.ignore-policy/1",
      source: "",
      sourceDigest: ignorePolicy.sourceDigest,
      sourceBytes: 0,
    },
  });
  const forge = new RecordingForge();
  const orchestrator = new JevyrOrchestrator({
    repository,
    events: new FileEventHub(data),
    minds: [new BlueprintMind("mind.local", "none")],
    forge,
    candidateIgnorePolicy: ignorePolicy,
    assayFrontier: frontier,
  });
  const created = await orchestrator.cast({
    protocol: "jevyr.case/1",
    case: {
      impulse: "`fixture` exits with code 0",
      subjects: [{ id: "source", kind: "directory", locator: subject }],
    },
  });
  const terminal = await orchestrator.waitForTerminal(created.caseId, 10_000);

  assert.equal(terminal.lifecycle, "terminated");
  assert.equal(forge.calls, 1);
  assert.equal(forge.observedText, "sealed physical bytes\n");
  assert.notEqual(forge.sourceRoot, subject);
  assert.notEqual(forge.sourceRoot, forge.subjectRoot);
  await assert.rejects(access(forge.sourceRoot as string));
  await assert.rejects(access(forge.subjectRoot as string));
});

test("a subject-dependent assay with declaration-only material is blocked without invoking Forge", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-declaration-flow-"));
  temporary.push(root);
  const impulse = "Inspect the remote declaration";
  const requestedAssay = "Compare the requested behavior against the sealed remote material";
  const obligationId = compileIntentContract({ impulse, requestedAssays: [requestedAssay] })
    .criticalObligations.find((entry) => entry.origin === "requested_assay")?.id;
  const plan = Object.freeze({
    assayId: "sealed.read-only-subject",
    costUnits: 1,
    tool: "forge.command",
    args: Object.freeze({ command: "fixture", args: Object.freeze([]) }),
    obligationId,
    requestedAssay: Object.freeze({
      definitionDigest: `sha256:${"1".repeat(64)}`,
      evaluatorDigest: `sha256:${"2".repeat(64)}`,
    }),
  });
  const frontier = compileAssayFrontier([plan], DEFAULT_SEARCH_PROFILE.resources);
  const ignorePolicy = await loadJevyrIgnorePolicy(root);
  const repository = new CaseRepository(join(root, "data"), {
    protocol: "jevyr.effective-policy/1",
    kernel: "jevyr.deterministic-policy/1",
    assayFrontierDigest: frontier.digest,
    assayFrontier: frontier,
    candidateIgnorePolicyDigest: ignorePolicy.sourceDigest,
    candidateIgnorePolicy: {
      protocol: "jevyr.ignore-policy/1",
      source: "",
      sourceDigest: ignorePolicy.sourceDigest,
      sourceBytes: 0,
    },
  });
  const forge = new RecordingForge();
  const events = new FileEventHub(join(root, "data"));
  const orchestrator = new JevyrOrchestrator({
    repository,
    events,
    minds: [new BlueprintMind("mind.local", "none")],
    forge,
    candidateIgnorePolicy: ignorePolicy,
    assayFrontier: frontier,
  });
  const created = await orchestrator.cast({
    protocol: "jevyr.case/1",
    case: {
      impulse,
      requestedAssays: [requestedAssay],
      subjects: [{ id: "remote", kind: "url", locator: "https://example.invalid/specimen" }],
    },
  });
  await orchestrator.waitForTerminal(created.caseId, 10_000);
  const ledger = await events.read(created.caseId);

  assert.equal(forge.calls, 0);
  assert.equal(ledger.some((event) => event.kind === "evidence.observed"
    && event.payload.summary.includes("declaration-only")), true);
});

test("an authority-free model blueprint is persisted and embodied only through the separately sealed plan", async () => {
  const { data, subject } = await fixture();
  const ignorePolicy = await loadJevyrIgnorePolicy(subject);
  const plan = Object.freeze({
    assayId: "blueprint.policy-command",
    costUnits: 1,
    tool: "forge.command",
    args: Object.freeze({ command: "policy-owned-command", args: Object.freeze([]) }),
  });
  const frontier = compileAssayFrontier([plan], DEFAULT_SEARCH_PROFILE.resources);
  const repository = new CaseRepository(data, {
    protocol: "jevyr.effective-policy/1",
    kernel: "jevyr.deterministic-policy/1",
    assayFrontierDigest: frontier.digest,
    assayFrontier: frontier,
    candidateIgnorePolicyDigest: ignorePolicy.sourceDigest,
    candidateIgnorePolicy: {
      protocol: "jevyr.ignore-policy/1",
      source: "",
      sourceDigest: ignorePolicy.sourceDigest,
      sourceBytes: 0,
    },
  });
  const forge = new BlueprintForge();
  const events = new FileEventHub(data);
  const orchestrator = new JevyrOrchestrator({
    repository,
    events,
    minds: [new BlueprintMind("mind.blueprint", "none")],
    forge,
    candidateIgnorePolicy: ignorePolicy,
    assayFrontier: frontier,
  });
  const created = await orchestrator.cast({
    protocol: "jevyr.case/1",
    case: {
      impulse: "`policy-owned-command` exits with code 0",
      subjects: [{ id: "source", kind: "directory", locator: subject }],
    },
  });
  const terminal = await orchestrator.waitForTerminal(created.caseId, 10_000);
  const ledger = await events.read(created.caseId);
  const artifacts = await repository.artifacts(created.caseId);

  assert.equal(terminal.lifecycle, "terminated");
  assert.equal(forge.calls, 1);
  assert.equal(forge.observedCandidate, "candidate bytes\n");
  assert.equal(forge.observedSubject, "sealed physical bytes\n");
  assert.equal(forge.observedCommand, "policy-owned-command");
  assert.notEqual(forge.observedCommand, "untrusted-proposal");
  assert.equal(artifacts.some((artifact) => artifact.mediaType === "application/vnd.jevyr.candidate-blueprint+json"), true);
  const diagnosticEvidence = ledger.filter((event) =>
    event.kind === "evidence.observed"
    && event.payload.evidenceType === "tool_observation"
    && event.payload.candidateId !== undefined
    && event.payload.assayId !== undefined);
  assert.ok(diagnosticEvidence.length > 0);
  assert.equal(ledger.some((event) => event.kind === "evidence.observed"
    && event.payload.evidenceType === "sandbox_execution"), false);
  for (const event of diagnosticEvidence) {
    const metadata = artifacts.find((artifact) => artifact.digest === event.payload.contentDigest);
    assert.equal(metadata?.mediaType, TOOL_OBSERVATION_MEDIA_TYPE);
    if (!metadata) throw new Error("diagnostic evidence has no durable artifact");
    const reopened = new CaseRepository(data);
    const persisted = await reopened.artifact(created.caseId, metadata.id);
    if (!persisted) throw new Error("observation artifact disappeared after reopening the repository");
    const observation = decodeToolObservation(persisted.data);
    assert.equal(observation.oracle?.execution.state, "exited");
  }
  assert.equal(ledger.some((event) => event.kind === "action.status"
    && event.payload.actionType === "candidate.blueprint.compile"
    && event.payload.status === "completed"), true);
  assert.equal(ledger.some((event) => event.kind === "candidate.status"
    && event.payload.status === "embodied"
    && (event.payload.artifactDigests?.length ?? 0) >= 2), true);
  await assert.rejects(access(forge.sourceRoot as string));
});
