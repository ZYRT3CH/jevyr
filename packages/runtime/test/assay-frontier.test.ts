import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { digestJson, type SealedSearchProfile } from "@jevyr/protocol";
import {
  CaseRepository,
  compileAssayFrontier,
  DEFAULT_SEARCH_PROFILE,
  FileEventHub,
  JevyrOrchestrator,
  loadJevyrIgnorePolicy,
  SealedForgeAdapter,
  verifyAssayFrontier,
  type AssayFrontier,
  type CapabilityCard,
  type MindAdapter,
  type MindRequest,
  type ProbeResult,
  type PublicContribution,
  type ToolAdapter,
  type ToolInvocation,
  type ToolObservation,
} from "../src/index.js";

const candidates = Object.freeze([
  Object.freeze({
    id: "candidate_zzz_measured",
    summary: "A restrained proposal that makes no claim to be the winner.",
  }),
  Object.freeze({
    id: "candidate_aaa_hype",
    summary: "The perfect flagship, unquestionably superior in every possible way.",
  }),
]);

class FrontierMind implements MindAdapter {
  readonly capability = Object.freeze({
    id: "mind.frontier-fixture",
    kind: "mind" as const,
    displayName: "Frontier fixture",
    version: "1",
    transport: "in-process" as const,
    trust: "quarantined" as const,
    modalities: Object.freeze(["text" as const]),
    network: "none" as const,
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
    // Deliberately emit the evidence winner first. The runtime later sorts by id,
    // so neither emission order nor the flattering prose can decide selection.
    for (const candidate of candidates) {
      yield Object.freeze({
        id: candidate.id,
        kind: "candidate" as const,
        summary: candidate.summary,
        feasibility: "BUILDABLE_NOW" as const,
        candidateBlueprintSource: {
          protocol: "jevyr.candidate-blueprint/1",
          files: [{ path: "identity.txt", content: `${candidate.id}\n` }],
          command: { executable: "model-command-must-never-run", args: [candidate.id] },
        },
      });
    }
  }
}

class ComparativeExperimentMind implements MindAdapter {
  readonly capability = Object.freeze({
    id: "mind.comparative-experiment-fixture",
    kind: "mind" as const,
    displayName: "Comparative experiment fixture",
    version: "1",
    transport: "in-process" as const,
    trust: "quarantined" as const,
    modalities: Object.freeze(["text" as const]),
    network: "none" as const,
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
    for (const candidate of candidates) {
      yield Object.freeze({
        id: candidate.id,
        kind: "candidate" as const,
        summary: candidate.summary,
        feasibility: "BUILDABLE_NOW" as const,
        candidateBlueprintSource: {
          protocol: "jevyr.candidate-blueprint/1",
          files: [
            { path: "identity.txt", content: `${candidate.id}\n` },
            { path: "jevyr.experiment.mjs", content: "process.exit(0);\n" },
          ],
          command: { executable: "node", args: ["jevyr.experiment.mjs"] },
        },
      });
    }
  }
}

interface ForgeCall {
  readonly command: string;
  readonly candidateId: string;
  readonly sourceRoot: string;
  readonly subjectRoot: string;
  readonly contaminatedBefore: boolean;
  readonly writableSubjectDuplicate: boolean;
  readonly operatorArgKeys: readonly string[];
}

interface FixedForgeOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly writableBytes?: number;
  readonly writableInodes?: number;
  readonly cpuMillis?: number;
  readonly artifactBytes?: number;
}

class FrontierForge implements ToolAdapter {
  readonly capability: CapabilityCard;
  readonly calls: ForgeCall[] = [];
  private repository?: CaseRepository;

  constructor(
    private readonly fixedOutcome?: Readonly<FixedForgeOutcome>,
    capabilityOverrides: Partial<CapabilityCard> = {},
  ) {
    this.capability = Object.freeze({
      id: "tool.frontier-fixture",
      kind: "tool" as const,
      displayName: "Frontier Forge fixture",
      version: "1",
      transport: "in-process" as const,
      trust: "local-deterministic" as const,
      modalities: Object.freeze(["files" as const, "commands" as const]),
      network: "none" as const,
      canExecuteTools: true,
      deterministic: true,
      ...capabilityOverrides,
    });
  }

  attachRepository(repository: CaseRepository): void {
    this.repository = repository;
  }

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    const sourceRoot = String(invocation.forgeMaterials?.protocol === "jevyr.forge-invocation-materials/1" ? invocation.forgeMaterials.candidate.sourceRoot : undefined);
    const subjectRoot = String(invocation.forgeMaterials?.subjects.subjectRoot);
    const candidateId = (await readFile(join(sourceRoot, "identity.txt"), "utf8")).trim();
    let contaminatedBefore = true;
    try {
      await access(join(sourceRoot, "contamination.txt"));
    } catch {
      contaminatedBefore = false;
    }
    let writableSubjectDuplicate = true;
    try {
      await access(join(sourceRoot, ".jevyr-subjects"));
    } catch {
      writableSubjectDuplicate = false;
    }
    await writeFile(join(sourceRoot, "contamination.txt"), invocation.invocationId, "utf8");
    const command = String(invocation.args.command);
    this.calls.push(Object.freeze({
      command,
      candidateId,
      sourceRoot,
      subjectRoot,
      contaminatedBefore,
      writableSubjectDuplicate,
      operatorArgKeys: Object.freeze(Object.keys(invocation.args).sort()),
    }));
    const bytes = this.fixedOutcome?.writableBytes ?? (candidateId === "candidate_zzz_measured" ? 1 : 50);
    const inodes = this.fixedOutcome?.writableInodes ?? 1;
    const exitCode = this.fixedOutcome?.exitCode ?? 0;
    const stdout = this.fixedOutcome?.stdout ?? `${candidateId}\n`;
    const artifactBytes = this.fixedOutcome?.artifactBytes ?? 0;
    const artifactRefs = artifactBytes === 0
      ? []
      : [
          (await this.repository?.putArtifact(
            invocation.caseId,
            `assay-${this.calls.length}.bin`,
            "application/octet-stream",
            Buffer.alloc(artifactBytes, 64 + (this.calls.length % 26)),
          ))?.id,
        ].filter((entry): entry is string => entry !== undefined);
    const now = new Date().toISOString();
    return Object.freeze({
      invocationId: invocation.invocationId,
      status: exitCode === 0 ? "succeeded" as const : "failed" as const,
      summary: `Measured ${candidateId} with ${command}.`,
      startedAt: now,
      finishedAt: now,
      exitCode,
      stdout,
      stderr: "",
      ...(artifactRefs.length === 0 ? {} : { artifactRefs: Object.freeze(artifactRefs) }),
      oracle: Object.freeze({
        execution: Object.freeze({
          state: "exited" as const,
          mode: "trusted-host" as const,
          command,
          args: Object.freeze([...(invocation.args.args as readonly string[] ?? [])]),
          shell: false,
          exitCode,
          stdout,
          stderr: "",
          outputTruncated: false,
        }),
      }),
      metadata: Object.freeze({
        changedFiles: Object.freeze(candidateId === "candidate_zzz_measured" ? [] : ["one", "two", "three"]),
        artifactReceipt: Object.freeze({
          protocol: "jevyr.forge-artifact-receipt/1" as const,
          invocationId: invocation.invocationId,
          artifactRefs: Object.freeze([...artifactRefs]),
          outputBytes: artifactBytes,
        }),
        resourceAccounting: Object.freeze({
          protocol: "jevyr.forge-resource-accounting/1",
          workspace: Object.freeze({
            byteCeiling: invocation.resourceLimits?.maxWritableBytes ?? 1_000_000,
            inodeCeiling: invocation.resourceLimits?.maxWritableInodes ?? 1_000,
            after: Object.freeze({ measurement: "MEASURED", complete: true, bytes, inodes }),
          }),
          cpu: this.fixedOutcome?.cpuMillis === undefined
            ? Object.freeze({ measurement: "DECLARED_ONLY", usedMillis: null })
            : Object.freeze({ measurement: "MEASURED", usedMillis: this.fixedOutcome.cpuMillis }),
        }),
      }),
    });
  }
}

class MismatchedInvocationForge extends FrontierForge {
  override async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    const observation = await super.execute(invocation);
    return Object.freeze({ ...observation, invocationId: "invocation_from_another_cell" });
  }
}

class CrashedForge extends FrontierForge {
  override async execute(): Promise<ToolObservation> {
    throw new Error("The sandbox connection disappeared after its successful startup probe.");
  }
}

class HangingForge implements ToolAdapter {
  readonly capability: CapabilityCard = Object.freeze({
    id: "tool.hanging-fixture",
    kind: "tool",
    displayName: "Hanging Forge fixture",
    version: "1",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: Object.freeze(["files", "commands"]),
    network: "none",
    canExecuteTools: true,
    deterministic: false,
  });
  calls = 0;

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async execute(): Promise<ToolObservation> {
    this.calls += 1;
    return await new Promise<ToolObservation>(() => undefined);
  }
}

class EventLoopBlockingForge implements ToolAdapter {
  readonly capability: CapabilityCard = Object.freeze({
    id: "tool.event-loop-blocking-fixture",
    kind: "tool",
    displayName: "Event-loop blocking Forge fixture",
    version: "1",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: Object.freeze(["commands"]),
    network: "none",
    canExecuteTools: true,
    deterministic: false,
  });
  calls = 0;

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    this.calls += 1;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, invocation.timeoutMs + 25);
    const now = new Date().toISOString();
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      summary: "A late opaque result that must never beat Bone's monotonic deadline.",
      startedAt: now,
      finishedAt: now,
      oracle: {
        execution: {
          state: "exited",
          mode: "docker",
          command: String(invocation.args.command),
          args: (invocation.args.args ?? []) as readonly string[],
          shell: false,
          exitCode: 0,
          stdout: "",
          stderr: "",
          outputTruncated: false,
        },
      },
      metadata: {
        admissible: true,
        resourceAccounting: {
          protocol: "jevyr.forge-resource-accounting/1",
          workspace: { after: { measurement: "MEASURED", complete: true, bytes: 0, inodes: 0 } },
          cpu: { measurement: "MEASURED", usedMillis: 0 },
        },
      },
    };
  }
}

function profileWith(overrides: Partial<SealedSearchProfile["resources"]> = {}): SealedSearchProfile {
  return Object.freeze({
    ...DEFAULT_SEARCH_PROFILE,
    nursery: Object.freeze({ ...DEFAULT_SEARCH_PROFILE.nursery }),
    resources: Object.freeze({ ...DEFAULT_SEARCH_PROFILE.resources, ...overrides }),
  });
}

function commandAssays(commands: readonly string[]) {
  return commands.map((command) => Object.freeze({
    assayId: `assay.${command}`,
    costUnits: 1,
    tool: "forge.command" as const,
    args: Object.freeze({ command, args: Object.freeze([]) }),
    timeoutMs: 10_000,
  }));
}

async function runCase(options: {
  readonly root: string;
  readonly frontier: AssayFrontier;
  readonly forge: ToolAdapter & { attachRepository?(repository: CaseRepository): void };
  readonly profile?: SealedSearchProfile;
  readonly boundDigest?: string;
  readonly impulse: string;
  readonly constraints?: readonly string[];
  readonly mind?: MindAdapter;
}) {
  const ignorePolicy = await loadJevyrIgnorePolicy(options.root);
  const repository = new CaseRepository(
    join(options.root, "data"),
    {
      protocol: "jevyr.effective-policy/1",
      kernel: "jevyr.deterministic-policy/1",
      assayFrontierDigest: options.boundDigest ?? options.frontier.digest,
      assayFrontier: options.frontier,
      candidateIgnorePolicyDigest: ignorePolicy.sourceDigest,
      candidateIgnorePolicy: {
        protocol: "jevyr.ignore-policy/1",
        source: "",
        sourceDigest: ignorePolicy.sourceDigest,
        sourceBytes: 0,
      },
    },
    {},
    { searchProfile: options.profile ?? DEFAULT_SEARCH_PROFILE },
  );
  const events = new FileEventHub(join(options.root, "data"));
  options.forge.attachRepository?.(repository);
  const orchestrator = new JevyrOrchestrator({
    repository,
    events,
    minds: [options.mind ?? new FrontierMind()],
    forge: options.forge,
    candidateIgnorePolicy: ignorePolicy,
    assayFrontier: options.frontier,
  });
  const created = await orchestrator.cast({
    protocol: "jevyr.case/1",
    case: {
      impulse: options.impulse,
      ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
    },
  });
  const terminal = await orchestrator.waitForTerminal(created.caseId, 10_000);
  return Object.freeze({
    terminal,
    ledger: await events.read(created.caseId),
    record: await repository.record(created.caseId),
  });
}

test("Assay Frontier compilation is canonical, versioned, bounded, and rejects hidden authority", () => {
  const left = compileAssayFrontier(commandAssays(["b", "a"]), DEFAULT_SEARCH_PROFILE.resources);
  const right = compileAssayFrontier(commandAssays(["a", "b"]), DEFAULT_SEARCH_PROFILE.resources);
  assert.equal(left.protocol, "jevyr.assay-frontier/1");
  assert.deepEqual(left.assays.map((entry) => entry.assayId), ["assay.a", "assay.b"]);
  assert.equal(left.digest, right.digest);
  assert.deepEqual(left.aggregateLimits, {
    maxForgeWallMillis: DEFAULT_SEARCH_PROFILE.resources.maxForgeWallMillis,
    maxForgeCpuMillis: DEFAULT_SEARCH_PROFILE.resources.maxForgeCpuMillis,
    maxTotalAssayCost: DEFAULT_SEARCH_PROFILE.resources.maxTotalAssayCost,
    maxWritableBytes: DEFAULT_SEARCH_PROFILE.resources.maxWritableBytes,
    maxWritableInodes: DEFAULT_SEARCH_PROFILE.resources.maxWritableInodes,
    maxArtifactBytes: DEFAULT_SEARCH_PROFILE.resources.maxArtifactBytes,
  });
  assert.throws(() => compileAssayFrontier([{ ...commandAssays(["a"])[0], hiddenWeakening: true }], DEFAULT_SEARCH_PROFILE.resources), /not a recognized assay field/u);
  assert.throws(() => compileAssayFrontier([{ ...commandAssays(["a"])[0], args: { command: "a", environment: { TOKEN: "secret" } } }], DEFAULT_SEARCH_PROFILE.resources), /not a recognized assay field/u);
  assert.throws(() => compileAssayFrontier([{ ...commandAssays(["a"])[0], args: { command: "a", sourceRoot: "." } }], DEFAULT_SEARCH_PROFILE.resources), /not a recognized assay field/u);
  assert.throws(() => compileAssayFrontier([{ ...commandAssays(["a"])[0], costUnits: 0 }], DEFAULT_SEARCH_PROFILE.resources), /positive safe integer/u);
  assert.throws(() => compileAssayFrontier([commandAssays(["a"])[0], commandAssays(["a"])[0]], DEFAULT_SEARCH_PROFILE.resources), /must be unique/u);
  assert.throws(() => compileAssayFrontier([], {
    ...DEFAULT_SEARCH_PROFILE.resources,
    maxTotalAssayCost: Number.MAX_SAFE_INTEGER + 1,
  }), /nonnegative safe integer/u);
  const tampered = structuredClone(left) as AssayFrontier & { digest: string };
  tampered.digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => verifyAssayFrontier(tampered, DEFAULT_SEARCH_PROFILE.resources), /canonical set/u);
});

test("Assay Frontier direct APIs snapshot only unambiguous data without invoking getters", () => {
  const ordinary = commandAssays(["plain"])[0]!;

  let getterReads = 0;
  const accessorPlan = { ...ordinary } as Record<string, unknown>;
  delete accessorPlan.timeoutMs;
  Object.defineProperty(accessorPlan, "timeoutMs", {
    enumerable: true,
    get() {
      getterReads += 1;
      return 10_000;
    },
  });
  assert.throws(
    () => compileAssayFrontier([accessorPlan], DEFAULT_SEARCH_PROFILE.resources),
    /must not be an accessor property/u,
  );
  assert.equal(getterReads, 0);

  const hiddenPlan = { ...ordinary } as Record<string, unknown>;
  Object.defineProperty(hiddenPlan, "approvalBypass", { value: true, enumerable: false });
  assert.throws(
    () => compileAssayFrontier([hiddenPlan], DEFAULT_SEARCH_PROFILE.resources),
    /enumerable own data property/u,
  );

  const symbolPlan = { ...ordinary } as Record<PropertyKey, unknown>;
  symbolPlan[Symbol("authority")] = true;
  assert.throws(
    () => compileAssayFrontier([symbolPlan], DEFAULT_SEARCH_PROFILE.resources),
    /must not contain symbol keys/u,
  );

  const inheritedPlan = Object.assign(Object.create({ timeoutMs: 1_000 }), ordinary) as Record<string, unknown>;
  assert.throws(
    () => compileAssayFrontier([inheritedPlan], DEFAULT_SEARCH_PROFILE.resources),
    /plain or null-prototype object/u,
  );

  let proxyTrapCalls = 0;
  const proxyPlan = new Proxy(ordinary, {
    get() {
      proxyTrapCalls += 1;
      return undefined;
    },
    getPrototypeOf() {
      proxyTrapCalls += 1;
      return Object.prototype;
    },
  });
  assert.throws(
    () => compileAssayFrontier([proxyPlan], DEFAULT_SEARCH_PROFILE.resources),
    /must not be a Proxy/u,
  );
  assert.equal(proxyTrapCalls, 0);

  let arrayGetterReads = 0;
  const accessorArray: unknown[] = [ordinary];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    configurable: true,
    get() {
      arrayGetterReads += 1;
      return ordinary;
    },
  });
  assert.throws(
    () => compileAssayFrontier(accessorArray, DEFAULT_SEARCH_PROFILE.resources),
    /enumerable own data property/u,
  );
  assert.equal(arrayGetterReads, 0);
  assert.throws(
    () => compileAssayFrontier(new Array<unknown>(1), DEFAULT_SEARCH_PROFILE.resources),
    /must not contain holes/u,
  );

  let resourceGetterReads = 0;
  const hostileResources = { ...DEFAULT_SEARCH_PROFILE.resources } as Record<string, unknown>;
  Object.defineProperty(hostileResources, "maxForgeWallMillis", {
    enumerable: true,
    get() {
      resourceGetterReads += 1;
      return 1;
    },
  });
  assert.throws(
    () => compileAssayFrontier([], hostileResources as unknown as SealedSearchProfile["resources"]),
    /must not be an accessor property/u,
  );
  assert.equal(resourceGetterReads, 0);

  const nullArgs = Object.assign(Object.create(null), { command: "null-prototype", args: [] }) as Record<string, unknown>;
  const nullPlan = Object.assign(Object.create(null), {
    assayId: "assay.null-prototype",
    costUnits: 1,
    tool: "forge.command",
    args: nullArgs,
  }) as Record<string, unknown>;
  assert.equal(compileAssayFrontier([nullPlan], DEFAULT_SEARCH_PROFILE.resources).assays[0]?.assayId, "assay.null-prototype");

  const compiled = compileAssayFrontier([{
    ...ordinary,
    sealedTestSuite: { suiteDigest: `sha256:${"a".repeat(64)}` },
    requestedAssay: {
      definitionDigest: `sha256:${"b".repeat(64)}`,
      evaluatorDigest: `sha256:${"c".repeat(64)}`,
    },
  }], DEFAULT_SEARCH_PROFILE.resources);
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.assays), true);
  assert.equal(Object.isFrozen(compiled.assays[0]), true);
  assert.equal(Object.isFrozen(compiled.assays[0]?.args), true);
  assert.equal(Object.isFrozen(compiled.assays[0]?.args.args), true);
  assert.equal(Object.isFrozen(compiled.assays[0]?.sealedTestSuite), true);
  assert.equal(Object.isFrozen(compiled.assays[0]?.requestedAssay), true);
  assert.equal(Object.isFrozen(compiled.aggregateLimits), true);
  assert.equal(Object.isFrozen(compiled.archive), true);

  const hostileFrontier = { ...compiled } as Record<string, unknown>;
  Object.defineProperty(hostileFrontier, "archive", {
    enumerable: true,
    get() {
      getterReads += 1;
      return compiled.archive;
    },
  });
  assert.throws(
    () => verifyAssayFrontier(hostileFrontier as unknown as AssayFrontier, DEFAULT_SEARCH_PROFILE.resources),
    /must not be an accessor property/u,
  );
  assert.equal(getterReads, 0);
});

test("every opaque candidate-assay cell is isolated but remains diagnostic-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-isolation-"));
  try {
    const plans = commandAssays(["assay-b", "assay-a"]);
    const frontier = compileAssayFrontier(plans, DEFAULT_SEARCH_PROFILE.resources);
    const forge = new FrontierForge();
    const result = await runCase({
      root,
      frontier,
      forge,
      impulse: "`assay-a` exits with code 0",
      constraints: ["`assay-b` exits with code 0"],
    });

    assert.equal(result.terminal.lifecycle, "terminated");
    assert.equal(forge.calls.length, 4);
    assert.equal(new Set(forge.calls.map((call) => call.sourceRoot)).size, 4);
    assert.equal(new Set(forge.calls.map((call) => call.subjectRoot)).size, 4);
    assert.equal(forge.calls.every((call) => call.contaminatedBefore === false), true);
    assert.equal(forge.calls.every((call) => call.writableSubjectDuplicate === false), true);
    assert.equal(forge.calls.every((call) => JSON.stringify(call.operatorArgKeys) === JSON.stringify(["args", "command"])), true);
    assert.equal(forge.calls.every((call) => call.sourceRoot !== call.subjectRoot
      && dirname(call.sourceRoot) === dirname(call.subjectRoot)), true);
    assert.equal(forge.calls.every((call) => call.command === "assay-a" || call.command === "assay-b"), true);
    assert.equal(forge.calls.some((call) => call.command === "model-command-must-never-run"), false);
    for (const call of forge.calls) await assert.rejects(access(call.sourceRoot));

    const selected = result.ledger.find((event) => event.kind === "candidate.status" && event.payload.status === "selected");
    const measuredProposal = result.ledger.find((event) => event.kind === "candidate.status"
      && event.payload.status === "proposed"
      && event.payload.summary.includes("restrained proposal"));
    const hypeProposal = result.ledger.find((event) => event.kind === "candidate.status"
      && event.payload.status === "proposed"
      && event.payload.summary.includes("perfect flagship"));
    assert.equal(selected, undefined);
    assert.equal(measuredProposal?.kind, "candidate.status");
    assert.equal(hypeProposal?.kind, "candidate.status");
    const comparative = result.ledger.filter((event) => event.kind === "assay.status" && event.payload.critical === false);
    assert.equal(comparative.length, 4);
    assert.equal(comparative.every((event) => event.payload.status === "blocked"), true);
    assert.equal(result.ledger.some((event) => event.kind === "evidence.observed"
      && ((event.payload.supports?.length ?? 0) > 0 || (event.payload.refutes?.length ?? 0) > 0)), false);
    assert.notEqual(result.record?.verdict.judgment, "ACCEPT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case-wide assay-cost exhaustion blocks every later cell without hidden work", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-exhaustion-"));
  try {
    const profile = profileWith({ maxTotalAssayCost: 1 });
    const frontier = compileAssayFrontier(commandAssays(["assay-a", "assay-b"]), profile.resources);
    const forge = new FrontierForge();
    const result = await runCase({
      root,
      frontier,
      forge,
      profile,
      impulse: "`assay-a` exits with code 0",
      constraints: ["`assay-b` exits with code 0"],
    });

    assert.equal(forge.calls.length, 1);
    const comparative = result.ledger.filter((event) => event.kind === "assay.status" && event.payload.critical === false);
    assert.equal(comparative.filter((event) => event.payload.status === "blocked").length, 4);
    assert.equal(result.ledger.some((event) => event.kind === "candidate.status" && event.payload.status === "selected"), false);
    const assayCostReadings = result.ledger
      .filter((event) => event.kind === "search.status")
      .flatMap((event) => event.payload.resources ?? [])
      .filter((entry) => entry.name === "totalAssayCost" && entry.used !== null);
    assert.equal(assayCostReadings.length > 0, true);
    assert.equal(assayCostReadings.every((entry) => (entry.used ?? 0) <= 1), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the live frontier spends a one-cell budget on the critical assay before alphabetically earlier comparative work", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-critical-first-"));
  try {
    const impulse = "`critical-check` exits with code 0";
    const obligationId = compileIntentContract({ impulse }).criticalObligations[0]!.id;
    const profile = profileWith({ maxTotalAssayCost: 1 });
    const frontier = compileAssayFrontier([
      { ...commandAssays(["aaa-comparative"])[0]!, assayId: "aaa-comparative" },
      { ...commandAssays(["critical-check"])[0]!, assayId: "zzz-critical", obligationId },
    ], profile.resources);
    const forge = new FrontierForge({ exitCode: 9, stdout: "observed planted defect" });
    const result = await runCase({ root, frontier, forge, profile, impulse });
    assert.equal(forge.calls.length, 1);
    assert.equal(forge.calls[0]!.command, "critical-check");
    assert.ok(result.ledger.some(event => event.kind === "action.status" && event.payload.actionType === "investigation.evidence-schedule" && event.payload.summary.includes("zzz-critical")));
    assert.ok(result.ledger.some(event => event.kind === "action.status" && event.payload.actionType === "investigation.phenotype"));
    // An opaque fixture still cannot create evidence authority despite improved scheduling.
    assert.equal(result.record?.verdict.judgment, "UNPROVEN", JSON.stringify(result.record?.verdict));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a candidate completed before frontier exhaustion still cannot be selected from a truncated matrix", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-truncated-matrix-"));
  try {
    const profile = profileWith({ maxTotalAssayCost: 1 });
    const frontier = compileAssayFrontier(commandAssays(["assay-a"]), profile.resources);
    const forge = new FrontierForge();
    const result = await runCase({
      root,
      frontier,
      forge,
      profile,
      impulse: "`assay-a` exits with code 0",
    });

    assert.equal(forge.calls.length, 1);
    assert.equal(result.ledger.some((event) => event.kind === "candidate.status"
      && (event.payload.status === "survived" || event.payload.status === "selected")), false);
    assert.equal(result.ledger.some((event) => event.kind === "search.status"
      && event.payload.termination === "RESOURCE_EXHAUSTED"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wall, measured CPU, writable, and artifact exhaustion stop the canonical frontier", async () => {
  const scenarios: readonly {
    readonly name: string;
    readonly resources: Partial<SealedSearchProfile["resources"]>;
    readonly outcome: FixedForgeOutcome;
    readonly maximumCalls: number;
  }[] = [
    {
      name: "wall",
      resources: { maxForgeWallMillis: 1_000 },
      outcome: { exitCode: 0, stdout: "ok", writableBytes: 1, writableInodes: 1 },
      maximumCalls: 1,
    },
    {
      name: "cpu",
      resources: { maxForgeCpuMillis: 10 },
      outcome: { exitCode: 0, stdout: "ok", writableBytes: 1, writableInodes: 1, cpuMillis: 6 },
      maximumCalls: 2,
    },
    {
      name: "writable-bytes",
      resources: { maxWritableBytes: 1_000 },
      outcome: { exitCode: 0, stdout: "ok", writableBytes: 600, writableInodes: 1 },
      maximumCalls: 2,
    },
    {
      name: "writable-inodes",
      resources: { maxWritableInodes: 10 },
      outcome: { exitCode: 0, stdout: "ok", writableBytes: 1, writableInodes: 6 },
      maximumCalls: 2,
    },
    {
      name: "artifacts",
      resources: { maxArtifactBytes: 50_000 },
      outcome: { exitCode: 0, stdout: "ok", writableBytes: 1, writableInodes: 1, artifactBytes: 30_000 },
      maximumCalls: 2,
    },
  ];
  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `jevyr-frontier-${scenario.name}-`));
    try {
      const profile = profileWith(scenario.resources);
      const frontier = compileAssayFrontier(commandAssays(["assay-a", "assay-b"]), profile.resources);
      const forge = new FrontierForge(scenario.outcome);
      const result = await runCase({
        root,
        frontier,
        forge,
        profile,
        impulse: "`assay-a` exits with code 0",
        constraints: ["`assay-b` exits with code 0"],
      });
      assert.equal(forge.calls.length, scenario.maximumCalls, scenario.name);
      assert.equal(result.ledger.some((event) => event.kind === "assay.status"
        && event.payload.critical === false
        && event.payload.status === "blocked"), true, scenario.name);
      assert.equal(result.ledger.some((event) => event.kind === "candidate.status"
        && event.payload.status === "selected"), false, scenario.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a typed exact-output claim from an opaque Forge remains diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-nonzero-"));
  try {
    const impulse = "The result returns exactly 7";
    const obligationId = compileIntentContract({ impulse }).criticalObligations[0]?.id;
    assert.ok(obligationId);
    const frontier = compileAssayFrontier([{
      assayId: "assay.exact-output",
      costUnits: 1,
      tool: "forge.command",
      args: { command: "emit", args: [] },
      obligationId,
    }], DEFAULT_SEARCH_PROFILE.resources);
    const forge = new FrontierForge({ exitCode: 7, stdout: "7" });
    const result = await runCase({ root, frontier, forge, impulse });
    assert.equal(forge.calls.length, 2);
    assert.notEqual(result.record?.verdict.judgment, "ACCEPT");
    assert.equal(result.ledger.some((event) => event.kind === "assay.status"
      && event.payload.status === "passed"
      && event.payload.critical === true), false);
    assert.equal(result.ledger.filter((event) => event.kind === "action.status"
      && event.payload.actionType === "forge.command"
      && event.payload.status === "completed").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("digest-shaped suite or requested-assay bindings cannot substitute for a Bone-owned evaluator", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-unavailable-evaluator-"));
  try {
    const [base] = commandAssays(["assay-a"]);
    if (!base) throw new Error("fixture plan missing");
    const frontier = compileAssayFrontier([{
      ...base,
      requestedAssay: {
        definitionDigest: `sha256:${"d".repeat(64)}`,
        evaluatorDigest: `sha256:${"e".repeat(64)}`,
      },
    }], DEFAULT_SEARCH_PROFILE.resources);
    const forge = new FrontierForge();
    const result = await runCase({
      root,
      frontier,
      forge,
      impulse: "`assay-a` exits with code 0",
    });

    assert.equal(forge.calls.length, 0);
    assert.equal(result.ledger.some((event) => event.kind === "action.status"
      && event.payload.summary.includes("no Bone-owned immutable evaluator substrate")), true);
    assert.equal(result.ledger.some((event) => event.kind === "candidate.status"
      && event.payload.status === "selected"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan cannot substitute a tree digest for the Case subject capture digest", async () => {
  const emptyCaptureDigest = digestJson({ protocol: "jevyr.subject-material-capture/1", bindings: [] });
  for (const [name, sealedSubjectDigest, expectedCalls] of [
    ["bound", emptyCaptureDigest, 2],
    ["substituted", `sha256:${"e".repeat(64)}`, 0],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), `jevyr-frontier-subject-binding-${name}-`));
    try {
      const frontier = compileAssayFrontier([{
        ...commandAssays(["assay-a"])[0],
        sealedSubjectDigest,
      }], DEFAULT_SEARCH_PROFILE.resources);
      const forge = new FrontierForge();
      const result = await runCase({ root, frontier, forge, impulse: "`assay-a` exits with code 0" });
      assert.equal(forge.calls.length, expectedCalls, name);
      if (name === "substituted") {
        assert.equal(result.ledger.some((event) => event.kind === "assay.status"
          && event.payload.summary.includes("Case subject material capture digest")), true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Forge capability cards cannot smuggle execution through the wrong kind, false execution flag, or unsafe network", async () => {
  const scenarios: readonly [string, Partial<CapabilityCard>][] = [
    ["wrong-kind", { kind: "mind" }],
    ["cannot-execute", { canExecuteTools: false }],
    ["unsafe-network", { network: "unrestricted" }],
  ];
  for (const [name, capability] of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `jevyr-frontier-capability-${name}-`));
    try {
      const frontier = compileAssayFrontier(commandAssays(["assay-a"]), DEFAULT_SEARCH_PROFILE.resources);
      const forge = new FrontierForge(undefined, capability);
      const result = await runCase({ root, frontier, forge, impulse: "`assay-a` exits with code 0" });
      assert.equal(forge.calls.length, 0, name);
      assert.equal(result.ledger.some((event) => event.kind === "candidate.status"
        && event.payload.status === "selected"), false, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("the built-in observe-only Forge remains a valid non-executing frontier witness", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-observe-only-"));
  try {
    const frontier = compileAssayFrontier(commandAssays(["assay-a"]), DEFAULT_SEARCH_PROFILE.resources);
    const result = await runCase({
      root,
      frontier,
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
      impulse: "`assay-a` exits with code 0",
    });
    assert.equal(result.terminal.lifecycle, "terminated");
    assert.equal(result.ledger.some((event) => event.kind === "action.status"
      && event.payload.summary.includes("observe-only mode")), true);
    assert.equal(result.ledger.some((event) => event.kind === "candidate.status"
      && event.payload.status === "selected"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Forge observation for another invocation is rejected before it can enter the measured archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-invocation-mismatch-"));
  try {
    const frontier = compileAssayFrontier(commandAssays(["assay-a"]), DEFAULT_SEARCH_PROFILE.resources);
    const forge = new MismatchedInvocationForge();
    const result = await runCase({ root, frontier, forge, impulse: "`assay-a` exits with code 0" });
    assert.equal(forge.calls.length, 2);
    assert.equal(result.ledger.some((event) => event.kind === "action.status"
      && event.payload.summary.includes("different invocation")), true);
    assert.equal(result.ledger.some((event) => event.kind === "candidate.status"
      && event.payload.status === "selected"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bone closes an opaque Forge cell at the sealed whole-call deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-bone-deadline-"));
  try {
    const profile = profileWith({ maxForgeWallMillis: 1_000 });
    const frontier = compileAssayFrontier(commandAssays(["assay-a"]), profile.resources);
    const forge = new HangingForge();
    const started = performance.now();
    const result = await runCase({ root, frontier, forge, profile, impulse: "`assay-a` exits with code 0" });
    assert.equal(forge.calls, 1);
    assert.ok(performance.now() - started < 4_000, "an opaque unresolved adapter must not own the Case deadline");
    assert.equal(result.ledger.some((event) => event.kind === "action.status"
      && event.payload.summary.includes("Bone closed the Forge cell")), true);
    assert.equal(result.ledger.some((event) => event.kind === "candidate.status"
      && event.payload.status === "selected"), false);
    assert.equal(result.ledger.some((event) => event.kind === "action.status"
      && event.payload.actionType.startsWith("integrity.")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Forge crash after a successful startup probe produces a kernel INVALID basis", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-forge-crash-"));
  try {
    const frontier = compileAssayFrontier(commandAssays(["assay-a"]), DEFAULT_SEARCH_PROFILE.resources);
    const result = await runCase({ root, frontier, forge: new CrashedForge(), impulse: "`assay-a` exits with code 0" });
    const failure = result.ledger.find((event) => event.kind === "action.status" && event.payload.actionType === "integrity.sandbox_failure");
    assert.ok(failure);
    assert.equal(failure.actor.kind, "kernel");
    assert.equal(failure.stage, "embody");
    assert.equal(result.record?.verdict.integrity, "INVALID");
    assert.equal(result.record?.verdict.basis.some((basis) => basis.code === "INTEGRITY_SANDBOX_FAILURE"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a synchronous adapter cannot beat the cell deadline by blocking the JavaScript event loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-event-loop-deadline-"));
  try {
    const profile = profileWith({ maxForgeWallMillis: 1_000 });
    const frontier = compileAssayFrontier(commandAssays(["assay-a"]), profile.resources);
    const forge = new EventLoopBlockingForge();
    const result = await runCase({ root, frontier, forge, profile, impulse: "`assay-a` exits with code 0" });
    assert.equal(forge.calls, 1);
    assert.equal(result.ledger.some((event) => event.kind === "action.status"
      && event.payload.summary.includes("Bone closed the Forge cell")), true);
    assert.equal(result.ledger.some((event) => event.kind === "candidate.status"
      && event.payload.status === "selected"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a zero Forge CPU envelope prohibits the first cell instead of measuring after execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-zero-cpu-"));
  try {
    const profile = profileWith({ maxForgeCpuMillis: 0 });
    const frontier = compileAssayFrontier(commandAssays(["assay-a"]), profile.resources);
    const forge = new FrontierForge({ exitCode: 0, stdout: "ok", writableBytes: 1, writableInodes: 1, cpuMillis: 0 });
    const result = await runCase({ root, frontier, forge, profile, impulse: "`assay-a` exits with code 0" });
    assert.equal(forge.calls.length, 0);
    assert.equal(result.ledger.some((event) => event.kind === "assay.status"
      && event.payload.summary.includes("CPU budget is zero")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unbound frontier or unbound plan performs no Forge work and proves nothing", async () => {
  for (const mode of ["set", "plan"] as const) {
    const root = await mkdtemp(join(tmpdir(), `jevyr-frontier-unbound-${mode}-`));
    try {
      const base = commandAssays(["assay-a"])[0] as NonNullable<ReturnType<typeof commandAssays>[number]>;
      const plans = mode === "plan"
        ? [{ ...base, obligationId: `obl_${"0".repeat(20)}` }]
        : [base];
      const frontier = compileAssayFrontier(plans, DEFAULT_SEARCH_PROFILE.resources);
      const forge = new FrontierForge();
      const result = await runCase({
        root,
        frontier,
        forge,
        ...(mode === "set" ? { boundDigest: `sha256:${"f".repeat(64)}` } : {}),
        impulse: "`assay-a` exits with code 0",
      });
      assert.equal(forge.calls.length, 0, mode);
      assert.equal(result.ledger.some((event) => event.kind === "candidate.status" && event.payload.status === "selected"), false, mode);
      assert.equal(result.ledger.some((event) => event.kind === "evidence.observed"
        && ((event.payload.supports?.length ?? 0) > 0 || (event.payload.refutes?.length ?? 0) > 0)), false, mode);
      assert.notEqual(result.record?.verdict.judgment, "ACCEPT", mode);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a pre-sealed narrow experiment runs without an Intent oracle but remains comparative-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-comparative-experiment-"));
  try {
    const frontier = compileAssayFrontier([{
      assayId: "jevyr.experiment.node-v1",
      costUnits: 1,
      tool: "forge.command",
      args: { command: "node", args: ["jevyr.experiment.mjs"] },
      timeoutMs: 30_000,
    }], DEFAULT_SEARCH_PROFILE.resources);
    const forge = new FrontierForge();
    const result = await runCase({
      root,
      frontier,
      forge,
      mind: new ComparativeExperimentMind(),
      impulse: "Create a finite mechanism whose actual behavior can be compared.",
    });
    assert.equal(result.terminal.lifecycle, "terminated");
    assert.equal(forge.calls.length, 2);
    assert.equal(forge.calls.every((call) => call.command === "node"), true);
    assert.equal(result.ledger.some((event) => event.kind === "action.status"
      && event.payload.actionType === "forge.command"
      && event.payload.status === "completed"), true);
    assert.equal(result.ledger.some((event) => event.kind === "evidence.observed"
      && ((event.payload.supports?.length ?? 0) > 0 || (event.payload.refutes?.length ?? 0) > 0)), false);
    assert.notEqual(result.record?.verdict.judgment, "ACCEPT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a comparative socket refuses candidates that do not propose its exact entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frontier-comparative-mismatch-"));
  try {
    const frontier = compileAssayFrontier([{
      assayId: "jevyr.experiment.node-v1",
      costUnits: 1,
      tool: "forge.command",
      args: { command: "node", args: ["jevyr.experiment.mjs"] },
    }], DEFAULT_SEARCH_PROFILE.resources);
    const forge = new FrontierForge();
    const result = await runCase({
      root,
      frontier,
      forge,
      impulse: "Create a finite mechanism.",
    });
    assert.equal(result.terminal.lifecycle, "terminated");
    assert.equal(forge.calls.length, 0);
    assert.equal(result.ledger.some((event) => event.kind === "action.status"
      && event.payload.status === "denied"
      && event.payload.summary.includes("not bound to sealed comparative experiment")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
