import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CaseRepository,
  compileAssayFrontier,
  decodeToolObservation,
  DEFAULT_SEARCH_PROFILE,
  FileEventHub,
  JevyrOrchestrator,
  loadJevyrIgnorePolicy,
  TOOL_OBSERVATION_MEDIA_TYPE,
  type CapabilityCard,
  type MindAdapter,
  type MindRequest,
  type ProbeResult,
  type PublicContribution,
  type ToolAdapter,
  type ToolInvocation,
  type ToolObservation,
} from "../src/index.js";

const CANDIDATE_ID = "candidate_artifact_boundary";

class ArtifactBoundaryMind implements MindAdapter {
  readonly capability: CapabilityCard = Object.freeze({
    id: "mind.artifact-boundary-fixture",
    kind: "mind",
    displayName: "Artifact boundary fixture",
    version: "1",
    transport: "in-process",
    trust: "quarantined",
    modalities: Object.freeze(["text"]),
    network: "none",
    canExecuteTools: false,
    deterministic: true,
  });
  private emitted = false;

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    if (request.stage !== "diverge" || this.emitted) return;
    this.emitted = true;
    yield Object.freeze({
      id: CANDIDATE_ID,
      kind: "candidate" as const,
      summary: "One finite candidate for exercising the artifact boundary.",
      feasibility: "BUILDABLE_NOW" as const,
      candidateBlueprintSource: Object.freeze({
        protocol: "jevyr.candidate-blueprint/1",
        files: Object.freeze([{ path: "identity.txt", content: `${CANDIDATE_ID}\n` }]),
        command: Object.freeze({ executable: "never-run-model-command", args: Object.freeze([]) }),
      }),
    });
  }
}

function fixtureCapability(id: string): CapabilityCard {
  return Object.freeze({
    id,
    kind: "tool",
    displayName: "Opaque artifact-boundary fixture",
    version: "1",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: Object.freeze(["files", "commands", "structured-data"]),
    network: "none",
    canExecuteTools: true,
    deterministic: true,
  });
}

function observation(
  invocation: ToolInvocation,
  artifactRefs: readonly string[],
  outputBytes: number,
): ToolObservation {
  const command = String(invocation.args.command);
  const now = new Date().toISOString();
  return Object.freeze({
    invocationId: invocation.invocationId,
    status: "succeeded" as const,
    summary: `Opaque Forge returned output for ${command}.`,
    startedAt: now,
    finishedAt: now,
    exitCode: 0,
    stdout: "",
    stderr: "",
    artifactRefs: Object.freeze([...artifactRefs]),
    oracle: Object.freeze({
      execution: Object.freeze({
        state: "exited" as const,
        mode: "trusted-host" as const,
        command,
        args: Object.freeze([...(invocation.args.args as readonly string[] ?? [])]),
        shell: false,
        exitCode: 0,
        stdout: "",
        stderr: "",
        outputTruncated: false,
      }),
    }),
    metadata: Object.freeze({
      artifactReceipt: Object.freeze({
        protocol: "jevyr.forge-artifact-receipt/1",
        invocationId: invocation.invocationId,
        artifactRefs: Object.freeze([...artifactRefs]),
        outputBytes,
      }),
      resourceAccounting: Object.freeze({
        protocol: "jevyr.forge-resource-accounting/1",
        workspace: Object.freeze({
          byteCeiling: invocation.resourceLimits?.maxWritableBytes ?? 1_000_000,
          inodeCeiling: invocation.resourceLimits?.maxWritableInodes ?? 1_000,
          after: Object.freeze({ measurement: "MEASURED", complete: true, bytes: 0, inodes: 0 }),
        }),
        cpu: Object.freeze({ measurement: "MEASURED", usedMillis: 0 }),
      }),
    }),
  });
}

class InvalidReferenceForge implements ToolAdapter {
  readonly capability = fixtureCapability("tool.invalid-artifact-reference-fixture");
  readonly outputDigests = new Map<string, string>();
  readonly returned = new Map<string, ToolObservation>();

  constructor(
    private readonly repository: CaseRepository,
    private readonly foreignArtifactId: string,
    private readonly foreignArtifactDigest: string,
  ) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    const command = String(invocation.args.command);
    let refs: readonly string[];
    let outputBytes: number;
    if (command === "duplicate-ref") {
      const bytes = Buffer.from("duplicate output", "utf8");
      const artifact = await this.repository.putArtifact(
        invocation.caseId,
        "duplicate-output.bin",
        "application/octet-stream",
        bytes,
      );
      this.outputDigests.set(command, artifact.digest);
      refs = Object.freeze([artifact.id, artifact.id]);
      outputBytes = bytes.byteLength;
    } else if (command === "missing-ref") {
      refs = Object.freeze([`artifact_${"f".repeat(24)}`]);
      outputBytes = Buffer.byteLength("claimed missing output", "utf8");
    } else if (command === "foreign-ref") {
      this.outputDigests.set(command, this.foreignArtifactDigest);
      refs = Object.freeze([this.foreignArtifactId]);
      outputBytes = Buffer.byteLength("foreign case output", "utf8");
    } else if (command === "internal-ref") {
      const bytes = Buffer.from("not actually a protocol observation", "utf8");
      const artifact = await this.repository.putArtifact(
        invocation.caseId,
        "internal-output.json",
        TOOL_OBSERVATION_MEDIA_TYPE,
        bytes,
      );
      this.outputDigests.set(command, artifact.digest);
      refs = Object.freeze([artifact.id]);
      outputBytes = bytes.byteLength;
    } else {
      throw new Error(`Unexpected fixture command ${command}`);
    }
    const result = observation(invocation, refs, outputBytes);
    this.returned.set(command, result);
    return result;
  }
}

class SameContentForge implements ToolAdapter {
  readonly capability = fixtureCapability("tool.same-content-artifact-fixture");
  readonly calls: string[] = [];
  readonly content = Buffer.from("identical bytes from every independent assay cell", "utf8");
  artifactId?: string;
  artifactDigest?: string;

  constructor(private readonly repository: CaseRepository) {}

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    const command = String(invocation.args.command);
    this.calls.push(command);
    const artifact = await this.repository.putArtifact(
      invocation.caseId,
      `same-output-${this.calls.length}.bin`,
      "application/octet-stream",
      this.content,
    );
    this.artifactId ??= artifact.id;
    this.artifactDigest ??= artifact.digest;
    assert.equal(artifact.id, this.artifactId);
    assert.equal(artifact.digest, this.artifactDigest);
    return observation(invocation, [artifact.id], this.content.byteLength);
  }
}

function assays(commands: readonly string[]) {
  return commands.map((command) => Object.freeze({
    assayId: `assay.${command}`,
    costUnits: 1,
    tool: "forge.command" as const,
    args: Object.freeze({ command, args: Object.freeze([]) }),
    timeoutMs: 10_000,
  }));
}

function castIntent(commands: readonly string[]) {
  return Object.freeze({
    protocol: "jevyr.case/1" as const,
    case: Object.freeze({
      impulse: `\`${commands[0]}\` exits with code 0`,
      constraints: Object.freeze(commands.slice(1).map((command) => `\`${command}\` exits with code 0`)),
    }),
  });
}

async function createRuntime(root: string, commands: readonly string[]) {
  const ignorePolicy = await loadJevyrIgnorePolicy(root);
  const frontier = compileAssayFrontier(assays(commands), DEFAULT_SEARCH_PROFILE.resources);
  const repository = new CaseRepository(
    join(root, "data"),
    {
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
    },
    {},
    { searchProfile: DEFAULT_SEARCH_PROFILE },
  );
  return Object.freeze({ ignorePolicy, frontier, repository });
}

async function run(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  forge: ToolAdapter,
  commands: readonly string[],
) {
  const events = new FileEventHub(runtime.repository.dataDir);
  const orchestrator = new JevyrOrchestrator({
    repository: runtime.repository,
    events,
    minds: [new ArtifactBoundaryMind()],
    forge,
    candidateIgnorePolicy: runtime.ignorePolicy,
    assayFrontier: runtime.frontier,
  });
  const created = await orchestrator.cast(castIntent(commands));
  const terminal = await orchestrator.waitForTerminal(created.caseId, 10_000);
  return Object.freeze({
    caseId: created.caseId,
    terminal,
    ledger: await events.read(created.caseId),
  });
}

async function assayObservations(
  repository: CaseRepository,
  caseId: string,
  ledger: Awaited<ReturnType<FileEventHub["read"]>>,
) {
  const artifacts = await repository.artifacts(caseId);
  const evidence = ledger.filter((event) => event.kind === "evidence.observed"
    && event.payload.evidenceType === "tool_observation"
    && event.payload.candidateId !== undefined
    && event.payload.assayId !== undefined);
  return await Promise.all(evidence.map(async (event) => {
    const meta = artifacts.find((artifact) => artifact.digest === event.payload.contentDigest);
    assert.equal(meta?.mediaType, TOOL_OBSERVATION_MEDIA_TYPE);
    if (!meta) throw new Error(`Missing persisted observation for ${event.payload.evidenceId}`);
    const persisted = await repository.artifact(caseId, meta.id);
    if (!persisted) throw new Error(`Persisted observation ${meta.id} disappeared`);
    return Object.freeze({ event, observation: decodeToolObservation(persisted.data) });
  }));
}

function metadataRecord(observationValue: ToolObservation, field: string): Record<string, unknown> {
  const value = observationValue.metadata?.[field];
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${field} must be an object`);
  return value as Record<string, unknown>;
}

test("Forge artifact refs are Case-local, unique, external, and never self-authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-artifact-boundary-invalid-"));
  try {
    const commands = Object.freeze(["duplicate-ref", "missing-ref", "foreign-ref", "internal-ref"]);
    const runtime = await createRuntime(root, commands);
    const foreignCase = await runtime.repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "A foreign Case used only to prove artifact scoping." },
    });
    const foreignBytes = Buffer.from("foreign case output", "utf8");
    const foreignArtifact = await runtime.repository.putArtifact(
      foreignCase.caseId,
      "foreign-output.bin",
      "application/octet-stream",
      foreignBytes,
    );
    const forge = new InvalidReferenceForge(runtime.repository, foreignArtifact.id, foreignArtifact.digest);
    const result = await run(runtime, forge, commands);

    assert.notEqual(result.terminal.lifecycle, "queued");
    assert.notEqual(result.terminal.lifecycle, "running");
    assert.deepEqual([...forge.returned.keys()].sort(), [...commands].sort());
    const duplicateRaw = forge.returned.get("duplicate-ref");
    assert.equal(duplicateRaw?.artifactRefs?.length, 2);
    assert.equal(duplicateRaw?.artifactRefs?.[0], duplicateRaw?.artifactRefs?.[1]);
    assert.equal(await runtime.repository.artifact(result.caseId, `artifact_${"f".repeat(24)}`), undefined);
    assert.equal(await runtime.repository.artifact(result.caseId, foreignArtifact.id), undefined);
    assert.equal((await runtime.repository.artifact(foreignCase.caseId, foreignArtifact.id))?.meta.digest, foreignArtifact.digest);
    const observations = await assayObservations(runtime.repository, result.caseId, result.ledger);
    assert.equal(observations.length, commands.length);
    for (const { observation: persisted } of observations) {
      assert.deepEqual(persisted.artifactRefs, []);
      assert.equal(persisted.metadata?.aggregateAdmissible, false);
      assert.equal(persisted.metadata?.executionAuthorityStatus, "BLOCKED");
      assert.equal(typeof persisted.metadata?.artifactBoundaryProblem, "string");
      const receipt = metadataRecord(persisted, "artifactReceipt");
      assert.deepEqual(receipt.artifactRefs, []);
      assert.equal(receipt.outputBytes, 0);
      const accounting = metadataRecord(persisted, "boneAccounting");
      assert.equal(accounting.artifactOutputBytes, 0);
      assert.equal(accounting.artifactStorageBytes, 0);
    }

    const byAssay = new Map(observations.map(({ observation: persisted }) =>
      [persisted.metadata?.assayId, persisted] as const));
    assert.match(String(byAssay.get("assay.duplicate-ref")?.summary), /invalid observation/u);
    assert.match(String(byAssay.get("assay.missing-ref")?.metadata?.artifactBoundaryProblem), /does not exist in this Case/u);
    assert.match(String(byAssay.get("assay.foreign-ref")?.metadata?.artifactBoundaryProblem), /does not exist in this Case/u);
    assert.match(String(byAssay.get("assay.internal-ref")?.metadata?.artifactBoundaryProblem), /internal Jevyr protocol artifact/u);

    const forgeActions = result.ledger.filter((event) =>
      event.kind === "action.status"
      && event.payload.actionType === "forge.command"
      && event.payload.status !== "started");
    assert.equal(forgeActions.length, commands.length);
    assert.equal(forgeActions.every((event) => (event.payload.artifactDigests?.length ?? 0) === 0), true);
    const rejectedOutputDigests = new Set(forge.outputDigests.values());
    assert.equal(result.ledger.some((event) => event.kind === "action.status"
      && event.payload.artifactDigests?.some((digest) => rejectedOutputDigests.has(digest))), false);

    const comparative = result.ledger.filter((event) =>
      event.kind === "assay.status" && event.payload.critical === false);
    assert.equal(comparative.length, commands.length);
    assert.equal(comparative.every((event) => event.payload.status === "blocked"), true);
    assert.equal(result.ledger.some((event) => event.kind === "evidence.observed"
      && (event.payload.evidenceType === "sandbox_execution"
        || (event.payload.supports?.length ?? 0) > 0
        || (event.payload.refutes?.length ?? 0) > 0)), false);
    assert.equal(result.ledger.some((event) => event.kind === "candidate.status"
      && event.payload.status === "selected"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-content outputs deduplicate CAS storage without deduplicating assay cells", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-artifact-boundary-same-content-"));
  try {
    const commands = Object.freeze(["same-a", "same-b", "same-c"]);
    const runtime = await createRuntime(root, commands);
    const forge = new SameContentForge(runtime.repository);
    const result = await run(runtime, forge, commands);

    assert.notEqual(result.terminal.lifecycle, "queued");
    assert.notEqual(result.terminal.lifecycle, "running");
    assert.equal(forge.calls.length, commands.length);
    assert.ok(forge.artifactId);
    assert.ok(forge.artifactDigest);
    const observations = await assayObservations(runtime.repository, result.caseId, result.ledger);
    assert.equal(observations.length, commands.length);
    assert.equal(new Set(observations.map(({ event }) => event.payload.contentDigest)).size, commands.length);
    assert.equal(new Set(observations.map(({ observation: persisted }) => persisted.invocationId)).size, commands.length);

    const outputAccounting: number[] = [];
    const storageAccounting: number[] = [];
    const aggregateStorage: number[] = [];
    for (const { observation: persisted } of observations) {
      assert.deepEqual(persisted.artifactRefs, [forge.artifactId]);
      const receipt = metadataRecord(persisted, "artifactReceipt");
      assert.deepEqual(receipt.artifactRefs, [forge.artifactId]);
      assert.equal(receipt.outputBytes, forge.content.byteLength);
      const accounting = metadataRecord(persisted, "boneAccounting");
      outputAccounting.push(accounting.artifactOutputBytes as number);
      storageAccounting.push(accounting.artifactStorageBytes as number);
      const aggregate = accounting.aggregateAfter as Record<string, unknown>;
      aggregateStorage.push(aggregate.artifactStorageBytes as number);
    }
    assert.deepEqual(outputAccounting, commands.map(() => forge.content.byteLength));
    assert.equal(storageAccounting.filter((bytes) => bytes === forge.content.byteLength).length, 1);
    assert.equal(storageAccounting.filter((bytes) => bytes === 0).length, commands.length - 1);
    assert.equal(new Set(aggregateStorage).size, 1);

    const storedOutputs = (await runtime.repository.artifacts(result.caseId)).filter((artifact) =>
      artifact.mediaType === "application/octet-stream" && artifact.digest === forge.artifactDigest);
    assert.equal(storedOutputs.length, 1);
    const forgeActions = result.ledger.filter((event) =>
      event.kind === "action.status"
      && event.payload.actionType === "forge.command"
      && event.payload.status !== "started");
    assert.equal(forgeActions.length, commands.length);
    assert.equal(forgeActions.every((event) =>
      event.payload.artifactDigests?.length === 1
      && event.payload.artifactDigests[0] === forge.artifactDigest), true);

    const comparative = result.ledger.filter((event) =>
      event.kind === "assay.status" && event.payload.critical === false);
    assert.equal(comparative.length, commands.length);
    const candidateId = observations[0]?.event.payload.candidateId;
    assert.ok(candidateId);
    const cellTelemetry = result.ledger.filter((event) => event.kind === "search.status"
      && event.payload.layer === "ASSAY_ARCHIVE"
      && event.payload.status === "exploring"
      && event.payload.candidateId === candidateId
      && event.payload.assayId !== undefined);
    assert.equal(cellTelemetry.length, commands.length);
    assert.deepEqual(cellTelemetry.map((event) => event.payload.attempted), [1, 2, 3]);
    assert.deepEqual(cellTelemetry.map((event) =>
      event.payload.resources?.find((entry) => entry.name === "totalAssayCost")?.used), [1, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
