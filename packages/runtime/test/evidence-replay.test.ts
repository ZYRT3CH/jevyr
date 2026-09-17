import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileIntentContract,
  compileVerdict,
  createCaseEvent,
  projectEvents,
  type EventDraft,
  type VerifiedEvidenceEdge,
} from "@jevyr/core";
import {
  canonicalize,
  digestJson,
  sha256Digest,
  type CaseEvent,
  type EventKind,
  type JsonValue,
  type SearchResourceEnvelope,
  type SearchResourceName,
  type SearchResourceTelemetry,
} from "@jevyr/protocol";
import {
  compileAssayFrontier,
  DEFAULT_SEARCH_PROFILE,
  decodeToolObservation,
  encodeToolObservation,
  exactByteCapture,
  sealedDockerForgeAuthority,
  stableId,
  verifyPersistedAssayEvidence,
  type AssayFrontier,
  type EncodedToolObservation,
  type SealedAssayPlan,
  type ToolObservation,
} from "../src/index.js";
import { encodePublicIdea } from "../src/public-ideas.js";

const CASE_ID = "case_persisted_replay";
const CASE_DIGEST = `sha256:${"a".repeat(64)}`;
const RUN_DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const IMAGE_REFERENCE = "jevyr/replay-fixture:sealed";
const IGNORE_POLICY_SOURCE = "forbidden/**\n";
const IGNORE_POLICY_DIGEST = sha256Digest(IGNORE_POLICY_SOURCE);
const SUBJECT_MATERIALIZATION_DIGEST = `sha256:${"e".repeat(64)}`;
const RESOURCE_NAMES: readonly SearchResourceName[] = [
  "mindInvocations", "inputTokens", "outputTokens", "wallMillis",
  "singleInvocationMillis", "generatedBytes", "forgeCpuMillis",
  "forgeWallMillis", "memorySeconds", "writableBytes", "writableInodes",
  "artifactBytes", "networkBytes", "concurrentLineages", "totalAssayCost",
];

const contract = compileIntentContract({ impulse: "`fixture --check` exits with code 0" });
const obligation = contract.criticalObligations[0];
assert.ok(obligation);

interface Usage {
  forgeWallMillis: number;
  measuredForgeCpuMillis: number;
  cpuMeasurements: number;
  cpuUnmeasured: boolean;
  workspaceUnmeasured: boolean;
  writableBytes: number;
  writableInodes: number;
  artifactBytes: number;
  totalAssayCost: number;
  attempted: number;
}

interface CandidateFixture {
  readonly id: string;
  readonly writableBytes: number;
  readonly blueprintDigest: string;
  readonly blueprintArtifactDigest: string;
  readonly blueprintBytes: Uint8Array;
}

interface RunFixture {
  readonly candidate: CandidateFixture;
  readonly plan: SealedAssayPlan;
  readonly observation: ToolObservation;
  readonly encoded: EncodedToolObservation;
  readonly executed: boolean;
  readonly admissible: boolean;
  readonly expectedStatus: "passed" | "failed" | "blocked";
  readonly usageAfter: Readonly<Usage>;
  readonly baseEvidenceId: string;
  baseEvent?: CaseEvent<"evidence.observed">;
}

interface TraceFixture {
  readonly events: readonly CaseEvent[];
  readonly precompileEvents: readonly CaseEvent[];
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
  readonly frontier: AssayFrontier;
  readonly policyDescriptor: Readonly<Record<string, unknown>>;
  readonly authorityEdges: readonly VerifiedEvidenceEdge[];
  readonly runs: readonly RunFixture[];
  readonly candidates: readonly CandidateFixture[];
  readonly resolve: (digest: string) => Promise<Uint8Array | undefined>;
}

interface TraceOptions {
  readonly candidateCount?: 1 | 2;
  readonly assayCount?: 1 | 2;
  readonly maxTotalAssayCost?: number;
  readonly diagnostic?: boolean;
  readonly diagnosticNoOracle?: boolean;
  readonly blueprintPath?: string;
  readonly blueprintIgnorePolicyDigest?: string;
  readonly failedExecution?: boolean;
}

function append<K extends EventKind>(
  events: CaseEvent[],
  draft: Omit<EventDraft<K>, "caseDigest" | "runDigest" | "observedAt">,
): CaseEvent<K> {
  const event = createCaseEvent({
    ...draft,
    caseDigest: CASE_DIGEST,
    runDigest: RUN_DIGEST,
    observedAt: new Date(Date.UTC(2026, 8, 4, 12, 0, events.length)).toISOString(),
  } as EventDraft<K>, events.length + 1, events.at(-1)?.eventDigest ?? null);
  events.push(event as CaseEvent);
  return event;
}

function cloneUsage(usage: Usage): Readonly<Usage> {
  return Object.freeze({ ...usage });
}

function blueprint(
  candidateId: string,
  path = "src/candidate.ts",
  ignorePolicyDigest = IGNORE_POLICY_DIGEST,
): CandidateFixture {
  const content = `export const candidate = ${JSON.stringify(candidateId)};\n`;
  const payload = Object.freeze({
    protocol: "jevyr.candidate-blueprint/1",
    files: Object.freeze([Object.freeze({
      path,
      content,
      byteLength: Buffer.byteLength(content, "utf8"),
      digest: sha256Digest(content),
    })]),
    ignorePolicyDigest,
    limits: Object.freeze({
      maxFiles: 8,
      maxFileBytes: 10_000,
      maxTotalBytes: 20_000,
      maxPathBytes: 256,
      maxCommandArgs: 8,
      maxArgumentBytes: 256,
      maxCommandBytes: 2_048,
    }),
  });
  const blueprintDigest = digestJson(payload as unknown as JsonValue);
  const compiled = Object.freeze({ ...payload, blueprintDigest });
  const blueprintBytes = new TextEncoder().encode(canonicalize(compiled as unknown as JsonValue));
  return Object.freeze({
    id: candidateId,
    writableBytes: candidateId.endsWith("b") ? 1 : 7,
    blueprintDigest,
    blueprintArtifactDigest: sha256Digest(blueprintBytes),
    blueprintBytes,
  });
}

function resourceEnvelope(maxTotalAssayCost: number): SearchResourceEnvelope {
  return Object.freeze({ ...DEFAULT_SEARCH_PROFILE.resources, maxTotalAssayCost });
}

function policy(frontier: AssayFrontier, diagnostic: boolean): Readonly<Record<string, unknown>> {
  const forgeSubstrateIdentity = diagnostic
    ? Object.freeze({
        protocol: "jevyr.forge-substrate-binding/1",
        adapterBoundary: "external",
        mode: "trusted-host",
        requestedReference: null,
        immutableImageId: null,
        resolutionAuthority: null,
        status: "unavailable",
        failure: "opaque-adapter",
      })
    : Object.freeze({
        protocol: "jevyr.forge-substrate-binding/1",
        adapterBoundary: "built-in",
        mode: "docker",
        requestedReference: IMAGE_REFERENCE,
        immutableImageId: IMAGE_ID,
        resolutionAuthority: "embedder-injected-resolver",
        status: "resolved",
        failure: null,
      });
  return Object.freeze({
    protocol: "jevyr.policy-descriptor/1",
    version: "jevyr.bone/1",
    subjectSnapshots: Object.freeze({}),
    policy: Object.freeze({
      protocol: "jevyr.effective-policy/1",
      assayFrontierDigest: frontier.digest,
      assayFrontier: frontier,
      candidateIgnorePolicyDigest: IGNORE_POLICY_DIGEST,
      candidateIgnorePolicy: Object.freeze({
        protocol: "jevyr.ignore-policy/1",
        source: IGNORE_POLICY_SOURCE,
        sourceDigest: IGNORE_POLICY_DIGEST,
        sourceBytes: Buffer.byteLength(IGNORE_POLICY_SOURCE, "utf8"),
      }),
      effectiveForgeConfig: diagnostic
        ? Object.freeze({ mode: "trusted-host", dockerImage: null, dockerCommand: null })
        : Object.freeze({ mode: "docker", dockerImage: IMAGE_REFERENCE, dockerCommand: null }),
      forgeSubstrateIdentity,
    }),
  });
}

function telemetry(
  usage: Readonly<Usage>,
  resources: SearchResourceEnvelope,
): readonly SearchResourceTelemetry[] {
  const measured: Partial<Record<SearchResourceName, number | null>> = {
    forgeCpuMillis: null,
    forgeWallMillis: usage.forgeWallMillis,
    writableBytes: usage.writableBytes,
    writableInodes: usage.writableInodes,
    artifactBytes: usage.artifactBytes,
    totalAssayCost: usage.totalAssayCost,
  };
  const ceilings: Record<SearchResourceName, number> = {
    mindInvocations: resources.maxMindInvocations,
    inputTokens: resources.maxInputTokens,
    outputTokens: resources.maxOutputTokens,
    wallMillis: resources.maxWallMillis,
    singleInvocationMillis: resources.maxSingleInvocationMillis,
    generatedBytes: resources.maxGeneratedBytes,
    forgeCpuMillis: resources.maxForgeCpuMillis,
    forgeWallMillis: resources.maxForgeWallMillis,
    memorySeconds: resources.maxMemorySeconds,
    writableBytes: resources.maxWritableBytes,
    writableInodes: resources.maxWritableInodes,
    artifactBytes: resources.maxArtifactBytes,
    networkBytes: resources.maxNetworkBytes,
    concurrentLineages: resources.concurrentLineages,
    totalAssayCost: resources.maxTotalAssayCost,
  };
  return Object.freeze(RESOURCE_NAMES.map((name) => {
    const used = measured[name];
    return Object.freeze({
      name,
      used: used ?? null,
      ceiling: ceilings[name],
      measurement: used === undefined || used === null ? "DECLARED_ONLY" as const : "MEASURED" as const,
    });
  }));
}

function boneAccounting(
  usage: Readonly<Usage>,
  wallMillis: number,
  costUnitsCharged: number,
  writableBytes: number | null,
  writableInodes: number | null,
) {
  return Object.freeze({
    protocol: "jevyr.bone-assay-accounting/1",
    wallMillis,
    costUnitsCharged,
    artifactOutputBytes: 0,
    artifactStorageBytes: 0,
    cpuMillis: null,
    writableBytes,
    writableInodes,
    aggregateAfter: Object.freeze({
      forgeWallMillis: usage.forgeWallMillis,
      measuredForgeCpuMillis: usage.measuredForgeCpuMillis,
      cpuMeasurements: usage.cpuMeasurements,
      cpuUnmeasured: usage.cpuUnmeasured,
      workspaceUnmeasured: usage.workspaceUnmeasured,
      totalAssayCost: usage.totalAssayCost,
      writableBytes: usage.writableBytes,
      writableInodes: usage.writableInodes,
      artifactStorageBytes: usage.artifactBytes,
    }),
  });
}

function rechain(events: readonly CaseEvent[]): readonly CaseEvent[] {
  const output: CaseEvent[] = [];
  for (const input of events) {
    const { sequence: _sequence, priorDigest: _prior, eventDigest: _digest, ...draft } = structuredClone(input);
    output.push(createCaseEvent(
      draft as EventDraft<EventKind>,
      output.length + 1,
      output.at(-1)?.eventDigest ?? null,
    ));
  }
  return Object.freeze(output);
}

function mutateEvents(
  events: readonly CaseEvent[],
  mutate: (event: CaseEvent) => CaseEvent | undefined,
): readonly CaseEvent[] {
  return rechain(events.flatMap((input) => {
    const result = mutate(structuredClone(input));
    return result === undefined ? [] : [result];
  }));
}

function buildTrace(options: TraceOptions = {}): TraceFixture {
  const candidateCount = options.candidateCount ?? 1;
  const assayCount = options.assayCount ?? 1;
  const maxTotalAssayCost = options.maxTotalAssayCost ?? 20;
  const diagnostic = options.diagnostic ?? false;
  const diagnosticNoOracle = diagnostic && (options.diagnosticNoOracle ?? false);
  const failedExecution = options.failedExecution ?? false;
  const resources = resourceEnvelope(maxTotalAssayCost);
  const frontier = compileAssayFrontier(
    Array.from({ length: assayCount }, (_, index) => ({
      assayId: `assay.persisted-${index + 1}`,
      costUnits: 3,
      tool: "forge.command" as const,
      args: { command: "fixture", args: ["--check"] },
      obligationId: obligation.id,
    })),
    resources,
  );
  const policyDescriptor = policy(frontier, diagnostic);
  const authority = sealedDockerForgeAuthority(policyDescriptor);
  if (!diagnostic) assert.equal(authority.verified, true);
  const candidates = Object.freeze(Array.from(
    { length: candidateCount },
    (_, index) => blueprint(
      `candidate_replay_${index === 0 ? "a" : "b"}`,
      options.blueprintPath ?? "src/candidate.ts",
      options.blueprintIgnorePolicyDigest ?? IGNORE_POLICY_DIGEST,
    ),
  ));
  const artifacts = new Map<string, Uint8Array>();
  for (const candidate of candidates) artifacts.set(candidate.blueprintArtifactDigest, candidate.blueprintBytes);

  const events: CaseEvent[] = [];
  for (const candidate of candidates) {
    append(events, {
      stage: "diverge",
      kind: "candidate.status",
      actor: { id: "mind.fixture", kind: "mind" },
      payload: {
        candidateId: candidate.id,
        status: "proposed",
        summary: `Finite proposal ${candidate.id}.`,
        feasibility: "BUILDABLE_NOW",
        parentIds: [],
        artifactDigests: [candidate.blueprintDigest, candidate.blueprintArtifactDigest].sort(),
      },
    });
  }
  const population = Object.freeze({
    protocol: "jevyr.candidate-population/1",
    caseId: CASE_ID,
    runDigest: RUN_DIGEST,
    assayFrontierDigest: frontier.digest,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({
      candidateId: candidate.id,
      blueprintDigest: candidate.blueprintDigest,
      blueprintArtifactDigest: candidate.blueprintArtifactDigest,
    }))),
  });
  const populationBytes = new TextEncoder().encode(canonicalize(population as unknown as JsonValue));
  const populationDigest = sha256Digest(populationBytes);
  assert.equal(populationDigest, digestJson(population as unknown as JsonValue));
  artifacts.set(populationDigest, populationBytes);
  append(events, {
    stage: "embody",
    kind: "action.status",
    actor: { id: "jevyr.bone", kind: "kernel" },
    payload: {
      actionId: stableId("population", { runDigest: RUN_DIGEST }),
      actionType: "candidate.population.close",
      status: "completed",
      summary: "Bone closed the exact finite population.",
      artifactDigests: [populationDigest],
    },
  });

  const initialArtifactBytes = candidates.reduce((sum, candidate) => sum + candidate.blueprintBytes.byteLength, 0);
  const usage: Usage = {
    forgeWallMillis: 0,
    measuredForgeCpuMillis: 0,
    cpuMeasurements: 0,
    cpuUnmeasured: false,
    workspaceUnmeasured: false,
    writableBytes: 0,
    writableInodes: 0,
    artifactBytes: initialArtifactBytes,
    totalAssayCost: 0,
    attempted: 0,
  };
  const runs: RunFixture[] = [];
  const embodied = new Set<string>();
  let exhaustionReason: string | undefined;

  for (const candidate of candidates) {
    for (const plan of frontier.assays) {
      const refusal = exhaustionReason
        ?? (plan.costUnits > frontier.aggregateLimits.maxTotalAssayCost - usage.totalAssayCost
          ? `Case-wide assay cost would exceed ${frontier.aggregateLimits.maxTotalAssayCost}.`
          : undefined);
      if (refusal !== undefined) {
        exhaustionReason = refusal;
        const invocationId = stableId("invocation", {
          runDigest: RUN_DIGEST,
          candidateId: candidate.id,
          assayId: plan.assayId,
          blocked: refusal,
        });
        const observation: ToolObservation = Object.freeze({
          invocationId,
          status: "not-executed",
          summary: refusal,
          startedAt: "2026-09-04T12:00:00.000Z",
          finishedAt: "2026-09-04T12:00:00.000Z",
          metadata: Object.freeze({
            reason: "assay-frontier-blocked",
            assayFrontierDigest: frontier.digest,
            candidateId: candidate.id,
            assayId: plan.assayId,
            planDigest: digestJson(plan as unknown as JsonValue),
            typedOracleStatus: "BLOCKED",
            executionAuthorityStatus: "BLOCKED",
            aggregateAdmissible: false,
            boneAccounting: boneAccounting(cloneUsage(usage), 0, 0, null, null),
          }),
        });
        const encoded = encodeToolObservation(observation);
        artifacts.set(encoded.digest, encoded.bytes);
        append(events, {
          stage: "embody",
          kind: "action.status",
          actor: { id: "jevyr.bone", kind: "kernel" },
          payload: { actionId: invocationId, actionType: plan.tool, status: "denied", summary: refusal },
        });
        runs.push({
          candidate, plan, observation, encoded, executed: false, admissible: false,
          expectedStatus: "blocked", usageAfter: cloneUsage(usage),
          baseEvidenceId: stableId("evidence", { runDigest: RUN_DIGEST, candidateId: candidate.id, assayId: plan.assayId }),
        });
        continue;
      }

      const invocationId = stableId("invocation", {
        runDigest: RUN_DIGEST,
        candidateId: candidate.id,
        assayId: plan.assayId,
      });
      const remainingBytes = frontier.aggregateLimits.maxWritableBytes - usage.writableBytes;
      const remainingInodes = frontier.aggregateLimits.maxWritableInodes - usage.writableInodes;
      append(events, {
        stage: "embody",
        kind: "action.status",
        actor: { id: "forge.fixture", kind: "forge" },
        payload: { actionId: invocationId, actionType: plan.tool, status: "started", summary: "Entered isolation." },
      });
      usage.forgeWallMillis += 10;
      usage.totalAssayCost += plan.costUnits;
      usage.attempted += 1;
      if (!diagnosticNoOracle) {
        usage.cpuUnmeasured = true;
        usage.writableBytes += candidate.writableBytes;
        usage.writableInodes += 1;
      }
      const aggregate = cloneUsage(usage);
      const emptyCapture = exactByteCapture(new Uint8Array());
      const execution = Object.freeze({
        state: "exited" as const,
        mode: diagnostic ? "trusted-host" as const : "docker" as const,
        command: "fixture",
        args: Object.freeze(["--check"]),
        shell: false,
        exitCode: failedExecution ? 9 : 0,
        stdout: "",
        stderr: "",
        stdoutCapture: emptyCapture,
        stderrCapture: emptyCapture,
        outputTruncated: false,
        ...(diagnostic ? {} : {
          substrate: Object.freeze({
            schema: "jevyr.docker-execution-substrate/1" as const,
            requestedReference: IMAGE_REFERENCE,
            startupResolvedImageId: IMAGE_ID,
            executionImageId: IMAGE_ID,
            contentAddressed: true as const,
            inspectedBeforeExecution: true as const,
          }),
        }),
      });
      const observation: ToolObservation = Object.freeze({
        invocationId,
        status: diagnosticNoOracle || failedExecution ? "failed" : "succeeded",
        summary: diagnosticNoOracle
          ? "The opaque adapter failed without a typed oracle."
          : diagnostic ? "Executed as a non-authoritative diagnostic." : "Executed in sealed Docker.",
        startedAt: "2026-09-04T12:00:00.000Z",
        finishedAt: "2026-09-04T12:00:00.010Z",
        ...(diagnosticNoOracle ? {} : { exitCode: failedExecution ? 9 : 0, stdout: "", stderr: "", oracle: Object.freeze({ execution }) }),
        metadata: Object.freeze({
          admissible: true,
          changedFiles: Object.freeze([]),
          assayFrontierDigest: frontier.digest,
          candidateId: candidate.id,
          assayId: plan.assayId,
          candidateBlueprintDigest: candidate.blueprintDigest,
          candidateMaterializationDigest: digestJson({ candidateId: candidate.id, blueprintDigest: candidate.blueprintDigest }),
          subjectMaterializationDigest: SUBJECT_MATERIALIZATION_DIGEST,
          planDigest: digestJson(plan as unknown as JsonValue),
          planBoundAtSeal: true,
          typedOracleStatus: diagnostic ? "BLOCKED" : failedExecution ? "FAILED" : "PASSED",
          executionAuthorityStatus: diagnostic ? "BLOCKED" : "VERIFIED",
          ...(diagnostic ? {} : { executionAuthorityDigest: authority.authority?.digest }),
          aggregateAdmissible: diagnostic ? false : true,
          artifactReceipt: Object.freeze({
            protocol: "jevyr.forge-artifact-receipt/1",
            invocationId,
            artifactRefs: Object.freeze([]),
            outputBytes: 0,
          }),
          resourceAccounting: Object.freeze({
            protocol: "jevyr.forge-resource-accounting/1",
            ...(diagnosticNoOracle ? {} : {
              workspace: Object.freeze({
                byteCeiling: remainingBytes,
                inodeCeiling: remainingInodes,
                after: Object.freeze({ measurement: "MEASURED", complete: true, bytes: candidate.writableBytes, inodes: 1 }),
              }),
            }),
            processOutput: Object.freeze({
              measurement: "MEASURED",
              usedBytes: 0,
              stdoutBytes: 0,
              stderrBytes: 0,
              retainedBytes: 0,
              exactCapturesComplete: true,
              ceilingBytes: 1_000_000,
              complete: true,
            }),
            cpu: Object.freeze({ measurement: "DECLARED_ONLY", usedMillis: null }),
          }),
          boneAccounting: boneAccounting(
            aggregate,
            10,
            plan.costUnits,
            diagnosticNoOracle ? null : candidate.writableBytes,
            diagnosticNoOracle ? null : 1,
          ),
        }),
      });
      const encoded = encodeToolObservation(observation);
      artifacts.set(encoded.digest, encoded.bytes);
      append(events, {
        stage: "embody",
        kind: "action.status",
        actor: { id: "forge.fixture", kind: "forge" },
        payload: {
          actionId: invocationId,
          actionType: plan.tool,
          status: diagnosticNoOracle ? "failed" : "completed",
          summary: "The isolated fixture completed.",
          resource: diagnosticNoOracle ? { wallMillis: 10 } : { wallMillis: 10, bytesWritten: candidate.writableBytes },
        },
      });
      if (!diagnosticNoOracle && !embodied.has(candidate.id)) {
        embodied.add(candidate.id);
        append(events, {
          stage: "embody",
          kind: "candidate.status",
          actor: { id: "forge.fixture", kind: "forge" },
          payload: {
            candidateId: candidate.id,
            status: "embodied",
            summary: "The finite candidate was physically executed.",
            artifactDigests: [candidate.blueprintDigest, candidate.blueprintArtifactDigest].sort(),
          },
        });
      }
      runs.push({
        candidate, plan, observation, encoded, executed: !diagnosticNoOracle, admissible: !diagnostic,
        expectedStatus: diagnostic ? "blocked" : failedExecution ? "failed" : "passed", usageAfter: aggregate,
        baseEvidenceId: stableId("evidence", { runDigest: RUN_DIGEST, candidateId: candidate.id, assayId: plan.assayId }),
      });
    }
  }

  for (const run of runs) {
    run.baseEvent = append(events, {
      stage: "assay",
      kind: "evidence.observed",
      actor: { id: "forge.fixture", kind: "forge" },
      payload: {
        evidenceId: run.baseEvidenceId,
        evidenceType: run.executed && !diagnostic ? "sandbox_execution" : "tool_observation",
        summary: `Base cell ${run.candidate.id}/${run.plan.assayId}.`,
        contentDigest: run.encoded.digest,
        candidateId: run.candidate.id,
        assayId: run.plan.assayId,
      },
    });
    append(events, {
      stage: "assay",
      kind: "assay.status",
      actor: { id: "jevyr.bone", kind: "kernel" },
      payload: {
        assayId: stableId("assay", { runDigest: RUN_DIGEST, candidateId: run.candidate.id, assayId: run.plan.assayId }),
        candidateId: run.candidate.id,
        obligationId: obligation.id,
        status: run.expectedStatus,
        critical: false,
        summary: "Comparative cell closure.",
        evidenceIds: [run.baseEvidenceId],
      },
    });
    append(events, {
      stage: "assay",
      kind: "search.status",
      actor: { id: "jevyr.bone", kind: "kernel" },
      payload: {
        layer: "ASSAY_ARCHIVE",
        status: "exploring",
        candidateId: run.candidate.id,
        assayId: run.plan.assayId,
        attempted: run.usageAfter.attempted,
        attemptSafetyCeiling: DEFAULT_SEARCH_PROFILE.attemptSafetyCeiling,
        resources: telemetry(run.usageAfter, resources),
        assayArchive: { measuredEntries: 0, occupiedNiches: 0 },
        summary: "Cumulative frontier telemetry.",
      },
    });
  }

  const finalUsage = cloneUsage(usage);
  const hasMeasuredArchive = exhaustionReason === undefined && !diagnostic && !failedExecution;
  for (const [index, candidate] of candidates.entries()) {
    append(events, {
      stage: "assay",
      kind: "search.status",
      actor: { id: "jevyr.bone", kind: "kernel" },
      payload: {
        layer: "ASSAY_ARCHIVE",
        status: hasMeasuredArchive ? "archive_changed" : "completed",
        candidateId: candidate.id,
        attempted: finalUsage.attempted,
        attemptSafetyCeiling: DEFAULT_SEARCH_PROFILE.attemptSafetyCeiling,
        resources: telemetry(finalUsage, resources),
        assayArchive: hasMeasuredArchive
          ? { measuredEntries: 1, occupiedNiches: 1, lastMeasuredNovelty: index === 0 ? 1 : 0 }
          : failedExecution && exhaustionReason === undefined && !diagnostic ? { measuredEntries: 0, occupiedNiches: 0, lastMeasuredNovelty: 1 } : { measuredEntries: 0, occupiedNiches: 0 },
        ...(exhaustionReason === undefined ? {} : { termination: "RESOURCE_EXHAUSTED" as const }),
        summary: "Deterministic archive admission outcome.",
      },
    });
  }

  const selectedCandidate = hasMeasuredArchive ? candidates.at(-1) : undefined;
  for (const candidate of candidates) {
    const survived = selectedCandidate?.id === candidate.id;
    append(events, {
      stage: "assay",
      kind: "candidate.status",
      actor: { id: "jevyr.bone", kind: "kernel" },
      payload: {
        candidateId: candidate.id,
        status: survived ? "survived" : "invalidated",
        summary: survived ? "Retained by the closed archive." : "Not retained by the closed archive.",
        ...(survived ? { feasibility: "BUILDABLE_NOW" as const } : runs.some((run) => run.candidate.id === candidate.id && run.expectedStatus === "failed") ? { feasibility: "CONTRADICTED" as const } : {}),
      },
    });
  }

  const authorityEdges: VerifiedEvidenceEdge[] = [];
  if (selectedCandidate !== undefined) {
    append(events, {
      stage: "assay",
      kind: "candidate.status",
      actor: { id: "jevyr.bone", kind: "kernel" },
      payload: {
        candidateId: selectedCandidate.id,
        status: "selected",
        summary: "Selected after complete archive closure.",
        feasibility: "BUILDABLE_NOW",
        parentIds: [],
      },
    });
    for (const run of runs.filter((entry) => entry.candidate.id === selectedCandidate.id && entry.admissible)) {
      const evidenceId = stableId("evidence", {
        runDigest: RUN_DIGEST,
        candidateId: run.candidate.id,
        assayId: run.plan.assayId,
        scope: "selected-candidate",
      });
      const authorityEvent = append(events, {
        stage: "assay",
        kind: "evidence.observed",
        actor: { id: "forge.fixture", kind: "forge" },
        payload: {
          evidenceId,
          evidenceType: "sandbox_execution",
          summary: "Winner-scoped typed authority.",
          contentDigest: run.encoded.digest,
          candidateId: run.candidate.id,
          assayId: run.plan.assayId,
          supports: [obligation.id],
        },
      });
      authorityEdges.push(Object.freeze({
        eventDigest: authorityEvent.eventDigest,
        evidenceId,
        contentDigest: run.encoded.digest,
        targetId: obligation.id,
        kind: "supports",
      }));
      append(events, {
        stage: "assay",
        kind: "assay.status",
        actor: { id: "jevyr.bone", kind: "kernel" },
        payload: {
          assayId: stableId("assay", { runDigest: RUN_DIGEST, candidateId: run.candidate.id, assayId: run.plan.assayId }),
          candidateId: run.candidate.id,
          obligationId: obligation.id,
          status: "passed",
          critical: true,
          summary: "Winner-scoped critical closure.",
          evidenceIds: [evidenceId],
        },
      });
    }
  }

  if (failedExecution && !diagnostic && exhaustionReason === undefined) {
    append(events, { stage: "assay", kind: "assay.status", actor: { id: "jevyr.bone", kind: "kernel" }, payload: {
      assayId: stableId("assay", { runDigest: RUN_DIGEST, scope: "closed-population" }),
      status: "failed", critical: true, scope: "closed_population", populationIds: candidates.map((candidate) => candidate.id),
      summary: "The finite admitted population failed its bound oracle.",
      evidenceIds: candidates.map((candidate) => runs.find((run) => run.candidate.id === candidate.id)!.baseEvidenceId).sort(),
    } });
  }
  const precompileEvents = Object.freeze([...events]);
  const projection = projectEvents(events, {
    policyVersion: "jevyr.bone/1",
    intentContract: contract,
    verifiedEvidenceEdges: authorityEdges,
  });
  const verdictDigest = digestJson(compileVerdict(projection.input) as unknown as JsonValue);
  append(events, {
    stage: "assay",
    kind: "kernel.status",
    actor: { id: "jevyr.bone", kind: "kernel" },
    payload: {
      operation: "policy_compiled",
      summary: "Bone committed the deterministic projected verdict.",
      artifactDigest: verdictDigest,
    },
  });
  return Object.freeze({
    events: Object.freeze(events),
    precompileEvents,
    artifacts,
    frontier,
    policyDescriptor,
    authorityEdges: Object.freeze(authorityEdges),
    runs: Object.freeze(runs),
    candidates,
    resolve: async (digest: string) => artifacts.get(digest),
  });
}

async function verify(
  trace: TraceFixture,
  events: readonly CaseEvent[] = trace.events,
  resolve: (digest: string) => Promise<Uint8Array | undefined> = trace.resolve,
  mode: "strict" | "precompile" = "strict",
) {
  return await verifyPersistedAssayEvidence(
    events,
    contract,
    trace.frontier,
    trace.policyDescriptor,
    resolve,
    { mode },
  );
}

test("strict replay reconstructs the full population, matrix, archive, authority, and policy marker", async () => {
  const trace = buildTrace();
  const report = await verify(trace);
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems, null, 2));
  assert.equal(report.mode, "strict");
  assert.equal(report.frontierState.matrixComplete, true);
  assert.equal(report.frontierState.expectedCellCount, 1);
  assert.equal(report.frontierState.observedCellCount, 1);
  assert.deepEqual(report.frontierState.survivorCandidateIds, ["candidate_replay_a"]);
  assert.equal(report.frontierState.selectedCandidateId, "candidate_replay_a");
  assert.deepEqual(report.verifiedAuthorityEdges, trace.authorityEdges);
  assert.equal(report.sandboxExecutionCount, 2);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.verifiedAuthorityEdges), true);
  assert.match(report.digest, /^sha256:[a-f0-9]{64}$/u);
});

test("public ideas are charged at their ledger prefix without rewriting earlier Forge physics", async () => {
  const trace = buildTrace({ candidateCount: 2 });
  const challengeIdea = encodePublicIdea("abstract-challenge", { summary: "A later, unassayed alternative." });
  const reflexIdea = encodePublicIdea("abstract-reflex", { summary: "A post-assay alternative." });
  const extra: CaseEvent[] = [];
  const challengeProposal = append(extra, {
    stage: "challenge", kind: "candidate.status", actor: { id: "mind.fixture", kind: "mind" },
    payload: { candidateId: challengeIdea.value.candidateId, status: "proposed", summary: challengeIdea.value.summary, artifactDigests: [challengeIdea.digest] },
  });
  const reflexProposal = append(extra, {
    stage: "reflex", kind: "candidate.status", actor: { id: "mind.fixture", kind: "mind" },
    payload: { candidateId: reflexIdea.value.candidateId, status: "proposed", summary: reflexIdea.value.summary, artifactDigests: [reflexIdea.digest] },
  });
  const archiveIndex = trace.precompileEvents.findIndex((event) => event.stage === "assay");
  const events = mutateEvents([
    ...trace.precompileEvents.slice(0, archiveIndex), challengeProposal,
    // Repeating a proposal citation retains one physical content-addressed blob.
    challengeProposal, ...trace.precompileEvents.slice(archiveIndex), reflexProposal,
  ], (event) => {
    if (event.kind === "search.status" && event.payload.layer === "ASSAY_ARCHIVE") {
      event.payload.resources = event.payload.resources.map((reading) => reading.name === "artifactBytes"
        ? { ...reading, used: (reading.used ?? 0) + challengeIdea.size } : reading);
    }
    return event;
  });
  const resolve = async (digest: string): Promise<Uint8Array | undefined> => digest === challengeIdea.digest
    ? challengeIdea.bytes : digest === reflexIdea.digest ? reflexIdea.bytes : await trace.resolve(digest);
  const report = await verify(trace, events, resolve, "precompile");
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems, null, 2));
  assert.equal(report.frontierState.aggregateUsage.artifactBytes,
    trace.candidates.reduce((sum, candidate) => sum + candidate.blueprintBytes.byteLength, 0) + challengeIdea.size);
  assert.equal(report.frontierState.cells.every((cell) => cell.status === "VERIFIED"), true);

  const missing = await verify(trace, events, async (digest) => digest === challengeIdea.digest ? undefined : await resolve(digest), "precompile");
  assert.equal(missing.problems.some((problem) => problem.code === "ARTIFACT_NOT_FOUND"), true);
  const concealedCharge = mutateEvents(events, (event) => {
    if (event.kind === "search.status" && event.payload.layer === "ASSAY_ARCHIVE") {
      event.payload.resources = event.payload.resources.map((reading) => reading.name === "artifactBytes"
        ? { ...reading, used: (reading.used ?? 0) - challengeIdea.size } : reading);
    }
    return event;
  });
  assert.equal((await verify(trace, concealedCharge, resolve, "precompile")).problems.some((problem) => problem.code === "RESOURCE_ACCOUNTING_MISMATCH"), true);

  const firstExecution = events.findIndex((event) => event.stage === "embody");
  const chargedEarlier = rechain([
    ...events.slice(0, firstExecution), { ...challengeProposal, stage: "diverge" as const },
    ...events.slice(firstExecution).filter((event) => !(event.kind === "candidate.status" && event.payload.candidateId === challengeIdea.value.candidateId)),
  ]);
  assert.equal((await verify(trace, chargedEarlier, resolve, "precompile")).problems.some((problem) => problem.code === "RESOURCE_ACCOUNTING_MISMATCH"), true);
});

test("a fully measured failed population is rejected without fabricating a flagship or global refutation", async () => {
  const trace = buildTrace({ candidateCount: 2, assayCount: 2, failedExecution: true });
  const report = await verify(trace);
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems, null, 2));
  assert.deepEqual(report.verifiedAuthorityEdges, []);
  assert.equal(report.frontierState.selectedCandidateId, undefined);
  assert.deepEqual(report.frontierState.survivorCandidateIds, []);
  const projection = projectEvents(trace.events, { intentContract: contract, verifiedEvidenceEdges: report.verifiedAuthorityEdges });
  const verdict = compileVerdict(projection.input);
  assert.equal(verdict.judgment, "REJECT");
  assert.equal(verdict.creation, "NO_SURVIVOR");
  assert.equal(verdict.basis.some((basis) => basis.code === "OBLIGATION_REFUTED"), false);
  const rejection = verdict.basis.find((basis) => basis.code === "ADMITTED_POPULATION_EXHAUSTED");
  assert.deepEqual(rejection?.candidateIds, trace.candidates.map((candidate) => candidate.id));
  assert.equal(rejection?.evidenceIds.length, 2);
  assert.match(rejection?.summary ?? "", /no impossibility claim/);
});

test("deleting or substituting a population rejection member or observation fails independent replay", async () => {
  const trace = buildTrace({ candidateCount: 2, failedExecution: true });
  const mutations: readonly ((event: CaseEvent) => CaseEvent | undefined)[] = [
    (event) => event.kind === "assay.status" && event.payload.scope === "closed_population" ? undefined : event,
    (event) => {
      if (event.kind === "assay.status" && event.payload.scope === "closed_population") event.payload.populationIds = ["candidate_replay_a", "unexamined-candidate"];
      return event;
    },
    (event) => {
      if (event.kind === "assay.status" && event.payload.scope === "closed_population") event.payload.evidenceIds = [event.payload.evidenceIds![0]!, "unexecuted-observation"];
      return event;
    },
  ];
  for (const mutation of mutations) {
    const report = await verify(trace, mutateEvents(trace.events, mutation));
    assert.equal(report.replayComplete, false);
    assert.equal(report.problems.some((problem) => problem.code === "CELL_EVENT_MISMATCH"), true);
  }
});

test("partial resource-exhausted failures remain UNPROVEN rather than rejecting untested population members", async () => {
  const trace = buildTrace({ candidateCount: 2, failedExecution: true, maxTotalAssayCost: 3 });
  const report = await verify(trace);
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems, null, 2));
  assert.equal(trace.events.some((event) => event.kind === "assay.status" && event.payload.scope === "closed_population"), false);
  assert.equal(compileVerdict(projectEvents(trace.events, { intentContract: contract }).input).judgment, "UNPROVEN");
});

test("persisted replay preserves exact invalid bytes and rejects byte-accounting aliases", async () => {
  const trace = buildTrace();
  const run = trace.runs[0];
  assert.ok(run);
  const replacements = [0x80, 0x81].map((byte) => {
    const observation = structuredClone(run.observation) as ToolObservation & {
      oracle: { execution: Record<string, unknown> };
      metadata: { resourceAccounting: { processOutput: Record<string, unknown> } };
    };
    delete observation.stdout;
    const capture = exactByteCapture(Uint8Array.from([byte]));
    observation.oracle.execution.stdoutCapture = capture;
    delete observation.oracle.execution.stdout;
    // Keep the old zero-byte receipt deliberately: replay must not treat a
    // JSON/base64 display length or an adapter claim as actual process use.
    const encoded = encodeToolObservation(observation);
    const decoded = decodeToolObservation(encoded.bytes);
    assert.equal(decoded.oracle?.execution.stdoutCapture?.digest, capture.digest);
    return encoded;
  });
  assert.notEqual(replacements[0]?.digest, replacements[1]?.digest);

  const replacement = replacements[0];
  assert.ok(replacement);
  const events = mutateEvents(trace.events, (event) => {
    if (event.kind === "evidence.observed" && event.payload.contentDigest === run.encoded.digest) {
      event.payload.contentDigest = replacement.digest;
    }
    return event;
  });
  const report = await verify(trace, events, async (digest) =>
    digest === replacement.digest ? replacement.bytes : await trace.resolve(digest));
  assert.equal(
    report.problems.some((entry) => entry.code === "PROCESS_OUTPUT_ACCOUNTING_MISMATCH"),
    true,
    JSON.stringify(report.problems, null, 2),
  );
  assert.deepEqual(report.verifiedAuthorityEdges, []);

  const correctlyAccounted = structuredClone(run.observation) as ToolObservation & {
    oracle: { execution: Record<string, unknown> };
    metadata: { resourceAccounting: { processOutput: Record<string, unknown> } };
  };
  delete correctlyAccounted.stdout;
  correctlyAccounted.oracle.execution.stdoutCapture = exactByteCapture(Uint8Array.from([0x80]));
  delete correctlyAccounted.oracle.execution.stdout;
  Object.assign(correctlyAccounted.metadata.resourceAccounting.processOutput, {
    usedBytes: 1,
    stdoutBytes: 1,
    stderrBytes: 0,
    retainedBytes: 1,
    exactCapturesComplete: true,
  });
  const correct = encodeToolObservation(correctlyAccounted);
  const correctedEvents = mutateEvents(trace.precompileEvents, (event) => {
    if (event.kind === "evidence.observed" && event.payload.contentDigest === run.encoded.digest) {
      event.payload.contentDigest = correct.digest;
    }
    return event;
  });
  const corrected = await verify(trace, correctedEvents, async (digest) =>
    digest === correct.digest ? correct.bytes : await trace.resolve(digest), "precompile");
  assert.equal(corrected.replayComplete, true, JSON.stringify(corrected.problems, null, 2));
  assert.equal(corrected.evidence[0]?.evaluation?.status, "PASSED");
});

test("precompile closes authority only before a policy marker exists", async () => {
  const trace = buildTrace();
  const precompile = await verify(trace, trace.precompileEvents, trace.resolve, "precompile");
  assert.equal(precompile.replayComplete, true, JSON.stringify(precompile.problems, null, 2));
  assert.deepEqual(precompile.verifiedAuthorityEdges, trace.authorityEdges);
  const markerPresent = await verify(trace, trace.events, trace.resolve, "precompile");
  assert.equal(markerPresent.replayComplete, false);
  assert.equal(markerPresent.problems.some((entry) => entry.code === "STATUS_ORDER_MISMATCH"), true);
  assert.deepEqual(markerPresent.verifiedAuthorityEdges, []);
});

test("strict policy marker is required and bound to Bone, ordering, and projected verdict", async () => {
  const trace = buildTrace();
  const missing = await verify(trace, trace.precompileEvents);
  assert.equal(missing.problems.some((entry) => entry.code === "STATUS_ORDER_MISMATCH"), true);
  const forged = mutateEvents(trace.events, (event) => {
    if (event.kind === "kernel.status" && event.payload.operation === "policy_compiled") {
      event.actor = { id: "model.fixture", kind: "mind" };
      event.payload.artifactDigest = `sha256:${"9".repeat(64)}`;
    }
    return event;
  });
  const forgedReport = await verify(trace, forged);
  assert.equal(forgedReport.problems.some((entry) => entry.code === "STATUS_ORDER_MISMATCH"), true);
  const marker = trace.events.find((event) => event.kind === "kernel.status" && event.payload.operation === "policy_compiled");
  assert.ok(marker);
  const withoutMarker = trace.events.filter((event) => event !== marker);
  const firstAssay = withoutMarker.findIndex((event) => event.stage === "assay");
  assert.notEqual(firstAssay, -1);
  const reorderedReport = await verify(trace, rechain([
    ...withoutMarker.slice(0, firstAssay),
    marker,
    ...withoutMarker.slice(firstAssay),
  ]));
  assert.equal(
    reorderedReport.problems.some((entry) => entry.code === "STATUS_ORDER_MISMATCH"),
    true,
    JSON.stringify(reorderedReport.problems, null, 2),
  );
});

test("strict policy marker commits its prefix without rejecting later authority-free Reflex claims", async () => {
  const trace = buildTrace();
  const events = [...trace.events];
  append(events, {
    stage: "reflex",
    kind: "claim.published",
    actor: { id: "mind.fixture", kind: "mind" },
    payload: {
      claimId: "claim_reflex_late_risk",
      statement: "A late advisory risk remains visible without acquiring verdict authority.",
      claimType: "risk",
      confidence: 0.5,
    },
  });

  const fullProjection = projectEvents(events, {
    policyVersion: "jevyr.bone/1",
    intentContract: contract,
    verifiedEvidenceEdges: trace.authorityEdges,
  });
  const fullLedgerVerdictDigest = digestJson(compileVerdict(fullProjection.input) as unknown as JsonValue);
  const marker = trace.events.find(
    (event) => event.kind === "kernel.status" && event.payload.operation === "policy_compiled",
  );
  assert.ok(marker?.kind === "kernel.status");
  assert.notEqual(marker.payload.artifactDigest, fullLedgerVerdictDigest);

  const report = await verify(trace, Object.freeze(events));
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems, null, 2));
});

test("population artifact mutation and population closure deletion fail closed", async () => {
  const trace = buildTrace();
  const populationAction = trace.events.find((event) => event.kind === "action.status" && event.payload.actionType === "candidate.population.close");
  assert.ok(populationAction && populationAction.kind === "action.status");
  const populationDigest = populationAction.payload.artifactDigests?.[0];
  assert.ok(populationDigest);
  const mutated = await verify(trace, trace.events, async (digest) =>
    digest === populationDigest ? new TextEncoder().encode("{\"tampered\":true}") : await trace.resolve(digest));
  assert.equal(mutated.problems.some((entry) => entry.code === "ARTIFACT_DIGEST_MISMATCH"), true);
  const deleted = await verify(trace, mutateEvents(trace.events, (event) =>
    event.kind === "action.status" && event.payload.actionType === "candidate.population.close" ? undefined : event));
  assert.equal(deleted.problems.some((entry) => entry.code === "MATRIX_INCOMPLETE"), true);
});

test("a caller-supplied Frontier cannot substitute for the one embedded in policy", async () => {
  const trace = buildTrace();
  const descriptor = structuredClone(trace.policyDescriptor) as Record<string, unknown>;
  const effective = descriptor.policy as Record<string, unknown>;
  effective.assayFrontierDigest = `sha256:${"8".repeat(64)}`;
  const report = await verifyPersistedAssayEvidence(
    trace.events,
    contract,
    trace.frontier,
    descriptor,
    trace.resolve,
  );
  assert.equal(report.replayComplete, false);
  assert.equal(report.problems.some((entry) => entry.code === "FRONTIER_BINDING_MISMATCH"), true);
  assert.deepEqual(report.verifiedAuthorityEdges, []);
});

test("candidate ignore-policy authority must be exact, present, and digest-correct", async () => {
  const trace = buildTrace();
  const mutations: readonly [string, (effective: Record<string, unknown>) => void][] = [
    ["missing", (effective) => {
      delete effective.candidateIgnorePolicy;
    }],
    ["tampered-source", (effective) => {
      const embedded = effective.candidateIgnorePolicy as Record<string, unknown>;
      embedded.source = `${String(embedded.source)}# changed after Seal\n`;
    }],
    ["non-exact", (effective) => {
      const embedded = effective.candidateIgnorePolicy as Record<string, unknown>;
      embedded.authority = "caller-selected";
    }],
  ];
  for (const [name, mutate] of mutations) {
    const descriptor = structuredClone(trace.policyDescriptor) as Record<string, unknown>;
    mutate(descriptor.policy as Record<string, unknown>);
    const report = await verifyPersistedAssayEvidence(
      trace.events,
      contract,
      trace.frontier,
      descriptor,
      trace.resolve,
    );
    assert.equal(report.replayComplete, false, name);
    assert.equal(
      report.problems.some((entry) => entry.code === "CANDIDATE_IGNORE_POLICY_MISMATCH"),
      true,
      name,
    );
    assert.deepEqual(report.verifiedAuthorityEdges, [], name);
  }
});

test("a self-digest-valid blueprint forbidden by the sealed ignore policy has no replay authority", async () => {
  const trace = buildTrace({ blueprintPath: "forbidden/candidate.ts" });
  const candidate = trace.candidates[0];
  assert.ok(candidate);
  assert.equal(sha256Digest(candidate.blueprintBytes), candidate.blueprintArtifactDigest);
  const decoded = JSON.parse(new TextDecoder().decode(candidate.blueprintBytes)) as Record<string, unknown>;
  const { blueprintDigest: ignored, ...payload } = decoded;
  assert.equal(ignored, candidate.blueprintDigest);
  assert.equal(digestJson(payload as JsonValue), candidate.blueprintDigest);

  const report = await verify(trace);
  assert.equal(report.replayComplete, false);
  assert.equal(
    report.problems.some((entry) => entry.code === "CANDIDATE_BLUEPRINT_POLICY_MISMATCH"),
    true,
    JSON.stringify(report.problems, null, 2),
  );
  assert.equal(report.problems.some((entry) => entry.code === "ARTIFACT_DECODE_FAILED"), false);
  assert.deepEqual(report.verifiedAuthorityEdges, []);
});

test("a self-digest-valid blueprint cannot substitute another ignore-policy digest", async () => {
  const trace = buildTrace({ blueprintIgnorePolicyDigest: sha256Digest("different ignore policy") });
  const candidate = trace.candidates[0];
  assert.ok(candidate);
  assert.equal(sha256Digest(candidate.blueprintBytes), candidate.blueprintArtifactDigest);

  const report = await verify(trace);
  assert.equal(report.replayComplete, false);
  assert.equal(
    report.problems.some((entry) => entry.code === "CANDIDATE_BLUEPRINT_POLICY_MISMATCH"),
    true,
    JSON.stringify(report.problems, null, 2),
  );
  assert.deepEqual(report.verifiedAuthorityEdges, []);
});

test("an omitted Cartesian cell cannot be hidden by status labels", async () => {
  const trace = buildTrace({ assayCount: 2 });
  const omittedAssay = trace.frontier.assays[1];
  assert.ok(omittedAssay);
  const omittedComparativeId = stableId("assay", { runDigest: RUN_DIGEST, candidateId: "candidate_replay_a", assayId: omittedAssay.assayId });
  const invocationId = stableId("invocation", { runDigest: RUN_DIGEST, candidateId: "candidate_replay_a", assayId: omittedAssay.assayId });
  const events = mutateEvents(trace.events, (event) => {
    if (event.kind === "evidence.observed" && event.payload.assayId === omittedAssay.assayId) return undefined;
    if (event.kind === "assay.status" && event.payload.assayId === omittedComparativeId) return undefined;
    if (event.kind === "search.status" && event.payload.assayId === omittedAssay.assayId) return undefined;
    if (event.kind === "action.status" && event.payload.actionId === invocationId) return undefined;
    return event;
  });
  const report = await verify(trace, events);
  assert.equal(report.frontierState.matrixComplete, false);
  assert.equal(report.problems.some((entry) => entry.code === "MATRIX_INCOMPLETE"), true);
  assert.deepEqual(report.verifiedAuthorityEdges, []);
});

test("resource exhaustion is reconstructed and fabricated survival is rejected", async () => {
  const trace = buildTrace({ assayCount: 2, maxTotalAssayCost: 3 });
  const report = await verify(trace);
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems, null, 2));
  assert.equal(report.frontierState.resourceExhausted, true);
  assert.equal(report.frontierState.attempted, 1);
  assert.deepEqual(report.frontierState.survivorCandidateIds, []);
  assert.deepEqual(report.verifiedAuthorityEdges, []);
  const fabricated = mutateEvents(trace.events, (event) => {
    if (event.kind === "candidate.status" && event.payload.status === "invalidated") {
      event.payload.status = "survived";
      event.payload.feasibility = "BUILDABLE_NOW";
    }
    return event;
  });
  const fabricatedReport = await verify(trace, fabricated);
  assert.equal(fabricatedReport.problems.some((entry) => entry.code === "ARCHIVE_STATE_MISMATCH"), true);
});

test("archive displacement determines survivor closure and flagship", async () => {
  const trace = buildTrace({ candidateCount: 2 });
  const report = await verify(trace);
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems, null, 2));
  assert.deepEqual(report.frontierState.survivorCandidateIds, ["candidate_replay_b"]);
  assert.equal(report.frontierState.selectedCandidateId, "candidate_replay_b");
  const fabricated = mutateEvents(trace.events, (event) => {
    if (event.kind === "candidate.status" && event.payload.candidateId === "candidate_replay_a" && event.payload.status === "invalidated") {
      event.payload.status = "survived";
      event.payload.feasibility = "BUILDABLE_NOW";
    }
    if (event.kind === "candidate.status" && event.payload.status === "selected") event.payload.candidateId = "candidate_replay_a";
    return event;
  });
  const fabricatedReport = await verify(trace, fabricated);
  assert.equal(fabricatedReport.problems.some((entry) => entry.code === "ARCHIVE_STATE_MISMATCH"), true);
  assert.equal(fabricatedReport.problems.some((entry) => entry.code === "FLAGSHIP_MISMATCH"), true);
  assert.deepEqual(fabricatedReport.verifiedAuthorityEdges, []);
});

test("executed non-authoritative diagnostics replay as facts and mint no verdict edge", async () => {
  const trace = buildTrace({ diagnostic: true });
  const report = await verify(trace);
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems, null, 2));
  assert.equal(report.sandboxExecutionCount, 0);
  assert.equal(report.evidence[0]?.recordedTypedStatus, "BLOCKED");
  assert.equal(report.evidence[0]?.aggregateAdmissible, false);
  assert.equal(report.evidence[0]?.authorityEdge, "NONE");
  assert.deepEqual(report.frontierState.survivorCandidateIds, []);
  assert.deepEqual(report.verifiedAuthorityEdges, []);
});

test("a failed diagnostic invocation without an oracle closes BLOCKED without invalidating replay", async () => {
  const trace = buildTrace({ diagnostic: true, diagnosticNoOracle: true });
  const report = await verify(trace);
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems, null, 2));
  assert.equal(report.sandboxExecutionCount, 0);
  assert.equal(report.frontierState.attempted, 1);
  assert.equal(report.frontierState.aggregateUsage.totalAssayCost, 3);
  assert.equal(report.frontierState.cells[0]?.expectedAssayStatus, "blocked");
  assert.equal(report.evidence[0]?.evaluation, undefined);
  assert.equal(report.evidence[0]?.authorityEdge, "NONE");
  assert.deepEqual(report.verifiedAuthorityEdges, []);
});

test("missing, corrupt, and noncanonical ToolObservation artifacts are rejected", async () => {
  const trace = buildTrace();
  const digest = trace.runs[0]?.encoded.digest;
  assert.ok(digest);
  const missing = await verify(trace, trace.events, async (requested) =>
    requested === digest ? undefined : await trace.resolve(requested));
  assert.equal(missing.problems.some((entry) => entry.code === "ARTIFACT_NOT_FOUND"), true);
  const corrupt = await verify(trace, trace.events, async (requested) =>
    requested === digest ? new TextEncoder().encode("not the committed bytes") : await trace.resolve(requested));
  assert.equal(corrupt.problems.some((entry) => entry.code === "ARTIFACT_DIGEST_MISMATCH"), true);
  const noncanonical = new TextEncoder().encode(JSON.stringify(trace.runs[0]?.observation, null, 2));
  const noncanonicalDigest = sha256Digest(noncanonical);
  const substitutedEvents = mutateEvents(trace.events, (event) => {
    if (event.kind === "evidence.observed" && event.payload.contentDigest === digest) event.payload.contentDigest = noncanonicalDigest;
    return event;
  });
  const substituted = await verify(trace, substitutedEvents, async (requested) =>
    requested === noncanonicalDigest ? noncanonical : await trace.resolve(requested));
  assert.equal(substituted.problems.some((entry) => entry.code === "ARTIFACT_DECODE_FAILED"), true);
});

test("scope substitution is rejected even when replacement artifact is canonical", async () => {
  const trace = buildTrace();
  const run = trace.runs[0];
  assert.ok(run);
  const observation = structuredClone(run.observation) as ToolObservation & { metadata: Record<string, unknown> };
  observation.metadata.candidateId = "candidate_substituted";
  const encoded = encodeToolObservation(observation);
  const events = mutateEvents(trace.events, (event) => {
    if (event.kind === "evidence.observed" && event.payload.contentDigest === run.encoded.digest) event.payload.contentDigest = encoded.digest;
    return event;
  });
  const report = await verify(trace, events, async (digest) =>
    digest === encoded.digest ? encoded.bytes : await trace.resolve(digest));
  assert.equal(report.problems.some((entry) => entry.code === "OBSERVATION_SCOPE_MISMATCH"), true);
  assert.deepEqual(report.verifiedAuthorityEdges, []);
});

test("conflicting canonical artifacts for one matrix cell reject every version", async () => {
  const trace = buildTrace();
  const run = trace.runs[0];
  assert.ok(run?.baseEvent);
  const secondObservation = structuredClone(run.observation) as ToolObservation & { summary: string };
  secondObservation.summary = "A second canonical artifact for the same cell.";
  const second = encodeToolObservation(secondObservation);
  const duplicate = createCaseEvent({
    caseDigest: CASE_DIGEST,
    runDigest: RUN_DIGEST,
    observedAt: "2026-09-04T12:59:00.000Z",
    stage: "assay",
    kind: "evidence.observed",
    actor: { id: "forge.fixture", kind: "forge" },
    payload: {
      evidenceId: "evidence_conflicting_cell",
      evidenceType: "sandbox_execution",
      summary: "A conflicting base cell artifact.",
      contentDigest: second.digest,
      candidateId: run.candidate.id,
      assayId: run.plan.assayId,
    },
  }, 1, null);
  const index = trace.events.findIndex((event) => event.eventDigest === run.baseEvent?.eventDigest);
  const events = rechain([...trace.events.slice(0, index + 1), duplicate, ...trace.events.slice(index + 1)]);
  const report = await verify(trace, events, async (digest) =>
    digest === second.digest ? second.bytes : await trace.resolve(digest));
  const conflicting = report.evidence.filter((entry) => entry.problemCodes.includes("CELL_ARTIFACT_CONFLICT"));
  assert.equal(conflicting.length >= 2, true);
  assert.equal(report.problems.some((entry) => entry.code === "CELL_ARTIFACT_CONFLICT"), true);
});
