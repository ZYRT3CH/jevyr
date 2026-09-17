import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSearchEnvelope, digestJson } from "@jevyr/protocol";
import { compileIntentContract, verifyDsse } from "@jevyr/core";
import {
  CaseRepository,
  compileAssayFrontier,
  DEFAULT_SEARCH_PROFILE,
  FileEventHub,
  JevyrOrchestrator,
  loadJevyrIgnorePolicy,
  RuleMindAdapter,
  SealedForgeAdapter,
  type MindRequest,
  type MindAdapter,
  type ProbeResult,
  type PublicContribution,
  type ToolAdapter,
  type ToolInvocation,
  type ToolObservation,
  seededUnit,
} from "../src/index.js";

const CASE_DIGEST = `sha256:${"a".repeat(64)}`;
const RUN_DIGEST = `sha256:${"b".repeat(64)}`;
const RULE_INTENT_CONTRACT = compileIntentContract({ impulse: "Build a self-discriminating substrate" });

class StageRecordingMind implements MindAdapter {
  readonly stages: MindRequest["stage"][] = [];
  readonly calls: { readonly stage: MindRequest["stage"]; readonly nursery: boolean }[] = [];
  readonly capability = Object.freeze({
    id: "mind.reasoning-fixture",
    kind: "mind" as const,
    displayName: "Reasoning fixture",
    version: "1",
    transport: "in-process" as const,
    trust: "local-deterministic" as const,
    modalities: Object.freeze(["text" as const, "structured-data" as const]),
    network: "none" as const,
    canExecuteTools: false,
    deterministic: true,
  });
  readonly #delegate = new RuleMindAdapter();

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    this.stages.push(request.stage);
    this.calls.push(Object.freeze({
      stage: request.stage,
      nursery: request.constraints.some((constraint) => constraint.startsWith("Nursery phase ")),
    }));
    yield* this.#delegate.run(request);
  }
}

class FiniteBlueprintMind extends RuleMindAdapter {
  private emitted = false;

  override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    if (request.stage !== "diverge" || this.emitted) return;
    this.emitted = true;
    yield Object.freeze({
      id: "candidate_measured_runtime",
      kind: "candidate" as const,
      summary: "A deliberately plain finite candidate; prose is not its score.",
      feasibility: "BUILDABLE_NOW" as const,
      candidateBlueprintSource: {
        protocol: "jevyr.candidate-blueprint/1",
        files: [{ path: "candidate.txt", content: "finite\n" }],
        command: { executable: "proposal-only", args: [] },
      },
    });
  }
}

class TypedPassForge implements ToolAdapter {
  readonly capability = Object.freeze({
    id: "tool.typed-pass",
    kind: "tool" as const,
    displayName: "Typed pass fixture",
    version: "1",
    transport: "in-process" as const,
    trust: "local-deterministic" as const,
    modalities: Object.freeze(["commands" as const]),
    network: "none" as const,
    canExecuteTools: true,
    deterministic: true,
  });

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "fixture" };
  }

  async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    const now = new Date().toISOString();
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      summary: "The exact sealed argv exited with code zero.",
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
      metadata: {
        resourceAccounting: {
          protocol: "jevyr.forge-resource-accounting/1",
          workspace: {
            byteCeiling: invocation.resourceLimits?.maxWritableBytes ?? 1_000_000,
            inodeCeiling: invocation.resourceLimits?.maxWritableInodes ?? 1_000,
            after: { measurement: "MEASURED", complete: true, bytes: 1, inodes: 1 },
          },
          cpu: { measurement: "DECLARED_ONLY", usedMillis: null },
        },
      },
    };
  }
}

test("seeded units remain in the documented half-open unit interval", () => {
  for (let index = 0; index < 1_000; index += 1) {
    const value = seededUnit("range-proof", index);
    assert.ok(value >= 0 && value < 1);
  }
});

test("RuleMind is deterministic for a canonical sealed request", async () => {
  const adapter = new RuleMindAdapter();
  const request: MindRequest = {
    stage: "diverge",
    role: "divergent",
    sealed: {
      protocol: "jevyr.case/1",
      caseId: "case_test_12345678",
      submissionDigest: `sha256:${"0".repeat(64)}`,
      caseDigest: CASE_DIGEST,
      runDigest: RUN_DIGEST,
      sealedAt: "2026-09-04T12:00:00.000Z",
      policyVersion: "jevyr.bone/1",
      policyDigest: `sha256:${"d".repeat(64)}`,
      genomeVersion: "jevyr.genome/1",
      genomeDigest: `sha256:${"e".repeat(64)}`,
      searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
      intentContractDigest: RULE_INTENT_CONTRACT.digest,
      intentContract: RULE_INTENT_CONTRACT,
      intent: {
        impulse: "Build a self-discriminating substrate",
        mode: "auto",
        subjects: [],
        constraints: [],
        requestedAssays: [],
        privacy: "local_only",
        control: "sovereign",
        seed: "fixed",
      },
      subjects: [],
    },
    publicFacts: [],
    seed: "fixed",
    constraints: [],
    signal: new AbortController().signal,
  };
  const collect = async () => {
    const values = [];
    for await (const value of adapter.run(request)) values.push(value);
    return values;
  };
  assert.deepEqual(await collect(), await collect());
});

test("event hub provides canonical durable 1-based cursors and wake-up polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-event-test-"));
  try {
    const hub = new FileEventHub(root);
    const caseId = "case_event_12345678";
    const wait = hub.wait(caseId, 0, 2_000);
    const first = await hub.append({
      caseId,
      caseDigest: CASE_DIGEST,
      runDigest: RUN_DIGEST,
      stage: "cast",
      kind: "stage.status",
      actor: { id: "bone", kind: "kernel" },
      payload: { stage: "cast", status: "entered", summary: "accepted" },
    });
    const page = await wait;
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.sequence, 1);
    const second = await hub.append({
      caseId,
      caseDigest: CASE_DIGEST,
      runDigest: RUN_DIGEST,
      stage: "cast",
      kind: "stage.status",
      actor: { id: "bone", kind: "kernel" },
      payload: { stage: "cast", status: "completed", summary: "sealed" },
    });
    assert.equal(second.sequence, 2);
    assert.equal(second.priorDigest, first.eventDigest);
    assert.match(second.eventDigest, /^sha256:[a-f0-9]{64}$/);
    const reloaded = new FileEventHub(root);
    assert.equal((await reloaded.list(caseId, 1)).events[0]?.sequence, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identical concurrent Casts retain one case identity but receive distinct run identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-repeat-test-"));
  try {
    const repository = new CaseRepository(root);
    const submission = { protocol: "jevyr.case/1" as const, case: { impulse: "Repeat this sealed case" } };
    const [first, second] = await Promise.all([repository.create(submission), repository.create(submission)]);
    assert.equal(first.sealed.caseDigest, second.sealed.caseDigest);
    assert.notEqual(first.sealed.runDigest, second.sealed.runDigest);
    assert.notEqual(first.caseId, second.caseId);
    assert.notEqual(first.sealed.sealedAt, second.sealed.sealedAt);
    assert.equal(first.receipt.policyDigest, repository.policyDigest);
    assert.equal(first.receipt.genomeDigest, repository.genomeDigest);
    assert.equal(first.receipt.searchDigest, repository.searchEnvelope.digest);
    assert.equal(first.sealed.searchEnvelope.digest, repository.searchEnvelope.digest);
    const [policy, genome, search] = await Promise.all([
      repository.descriptor(repository.policyDigest),
      repository.descriptor(repository.genomeDigest),
      repository.descriptor(repository.searchEnvelope.digest),
    ]);
    assert.equal(policy?.kind, "policy");
    assert.equal(genome?.kind, "genome");
    assert.equal(search?.kind, "search");
    assert.equal(genome?.descriptor && digestJson(genome.descriptor), repository.genomeDigest);
    assert.equal(search?.descriptor && digestJson(search.descriptor), repository.searchEnvelope.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator completes a one-way case and signs an UNPROVEN canonical record", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-run-test-"));
  try {
    const repository = new CaseRepository(root);
    const events = new FileEventHub(root);
    const orchestrator = new JevyrOrchestrator({
      repository,
      events,
      minds: [new RuleMindAdapter()],
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
    });
    const created = await orchestrator.cast({ protocol: "jevyr.case/1", case: { impulse: "Judge a novel control substrate" } });
    const terminal = await orchestrator.waitForTerminal(created.caseId, 10_000);
    assert.equal(terminal.lifecycle, "terminated");
    const page = await events.list(created.caseId, 0, 2_000);
    assert.deepEqual(page.events.map((event) => event.sequence), page.events.map((_, index) => index + 1));
    assert.equal(page.events.some((event) => event.stage === "seal" && event.kind === "kernel.status"), true);
    assert.equal(page.events.some((event) => event.stage === "terminate" && event.kind === "kernel.status"), true);
    assert.equal(page.events.every((event) => event.caseDigest === created.sealed.caseDigest), true);

    const record = await repository.record(created.caseId);
    const envelope = await repository.recordEnvelope(created.caseId);
    assert.ok(record);
    assert.ok(envelope);
    assert.equal(record.verdict.creation, "NO_SURVIVOR");
    assert.equal(record.verdict.embodiment, "NOT_BUILT");
    assert.equal(record.verdict.judgment, "UNPROVEN");
    assert.equal(record.policyDigest, repository.policyDigest);
    assert.equal(record.genomeDigest, repository.genomeDigest);
    assert.equal(record.searchDigest, repository.searchEnvelope.digest);
    const publicPem = await readFile(join(root, "keys", "jevyr-ed25519-public.pem"), "utf8");
    assert.equal(verifyDsse(envelope, new Map([[envelope.signatures[0]?.keyid ?? "", publicPem]])), true);
    assert.equal(Buffer.from(envelope.payload, "base64").toString("utf8"), JSON.stringify(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"))));
    assert.match(record.eventHeadDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(digestJson(record as never), /^sha256:[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default 12-call envelope preserves real recombination, challenge, and Reflex calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-stage-budget-test-"));
  try {
    const repository = new CaseRepository(root);
    const events = new FileEventHub(root);
    const mind = new StageRecordingMind();
    const orchestrator = new JevyrOrchestrator({
      repository,
      events,
      minds: [mind],
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
    });
    const created = await orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "Preserve invention and then genuinely inspect it" },
    });
    await orchestrator.waitForTerminal(created.caseId, 10_000);

    const lifecycleCount = (stage: MindRequest["stage"]): number =>
      mind.calls.filter((entry) => entry.stage === stage && !entry.nursery).length;
    assert.equal(lifecycleCount("interpret"), 1);
    assert.ok(mind.calls.filter((entry) => entry.nursery).length >= 1);
    assert.equal(lifecycleCount("recombine"), 1);
    assert.equal(lifecycleCount("challenge"), 1);
    assert.equal(lifecycleCount("reflex"), 1);
    assert.ok(mind.stages.length <= DEFAULT_SEARCH_PROFILE.resources.maxMindInvocations);

    const ledger = await events.read(created.caseId);
    assert.equal(ledger.some((event) =>
      event.kind === "search.status"
      && event.payload.summary.includes("3 remain reserved for recombination, challenge, and Reflex")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a two-call envelope skips early commentary truthfully to preserve invention and Reflex", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-low-stage-budget-test-"));
  try {
    const lowBudgetProfile = {
      ...DEFAULT_SEARCH_PROFILE,
      resources: { ...DEFAULT_SEARCH_PROFILE.resources, maxMindInvocations: 2 },
    };
    const repository = new CaseRepository(root, undefined, {}, { searchProfile: lowBudgetProfile });
    const events = new FileEventHub(root);
    const mind = new StageRecordingMind();
    const orchestrator = new JevyrOrchestrator({
      repository,
      events,
      minds: [mind],
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
    });
    const created = await orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "Use two calls without pretending every stage spoke" },
    });
    await orchestrator.waitForTerminal(created.caseId, 10_000);

    assert.deepEqual(mind.stages, ["diverge", "reflex"]);
    const ledger = await events.read(created.caseId);
    for (const stage of ["interpret", "recombine", "challenge"] as const) {
      assert.equal(ledger.some((event) =>
        event.stage === stage
        && event.kind === "action.status"
        && event.payload.status === "denied"
        && event.payload.summary.includes("remaining sealed Mind calls are reserved")), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a policy-bound typed oracle still needs the sealed built-in Docker substrate", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-typed-assay-test-"));
  try {
    const commandText = "fixture --version";
    const impulse = `\`${commandText}\` exits with code 0`;
    const contract = compileIntentContract({ impulse });
    const obligation = contract.criticalObligations[0];
    assert.equal(obligation?.oracle?.kind, "command_exit_code");
    const plan = Object.freeze({
      assayId: "runtime.node-version",
      costUnits: 1,
      tool: "forge.command" as const,
      args: Object.freeze({ command: "fixture", args: Object.freeze(["--version"]) }),
      obligationId: obligation?.id as string,
      timeoutMs: 10_000,
    });
    const frontier = compileAssayFrontier([plan], DEFAULT_SEARCH_PROFILE.resources);
    const ignorePolicy = await loadJevyrIgnorePolicy(root);
    const repository = new CaseRepository(root, {
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
    const events = new FileEventHub(root);
    const orchestrator = new JevyrOrchestrator({
      repository,
      events,
      minds: [new FiniteBlueprintMind()],
      forge: new TypedPassForge(),
      candidateIgnorePolicy: ignorePolicy,
      assayFrontier: frontier,
    });

    const created = await orchestrator.cast({ protocol: "jevyr.case/1", case: { impulse } });
    await orchestrator.waitForTerminal(created.caseId, 10_000);
    const record = await repository.record(created.caseId);
    const ledger = await events.read(created.caseId);

    assert.notEqual(record?.verdict.judgment, "ACCEPT");
    assert.equal(record?.verdict.basis.some((entry) => entry.code === "SEALED_OBLIGATIONS_SATISFIED"), false);
    assert.equal(ledger.some((event) =>
      event.kind === "assay.status" && event.payload.status === "blocked" && event.payload.candidateId !== undefined), true);
    assert.equal(ledger.some((event) =>
      event.kind === "evidence.observed" && event.payload.supports?.includes(obligation?.id as string)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker-default Forge reports unavailable daemon without host fallback", async () => {
  const forge = new SealedForgeAdapter({ mode: "docker", dockerCommand: "definitely-not-a-jevyr-command" });
  const observation = await forge.execute({
    invocationId: "invocation_test",
    caseId: "case_forge_12345678",
    tool: "forge.command",
    args: { command: "node", args: ["--version"] },
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(observation.status, "not-executed");
  assert.equal(observation.metadata?.reason, "docker-unavailable");
});
