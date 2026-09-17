import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  adapterCapabilitySnapshot,
  DEFAULT_SEARCH_PROFILE,
  RuleMindAdapter,
  SealedForgeAdapter,
  type CapabilityCard,
  type MindAdapter,
} from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
import { JevyrClient } from "../../../packages/sdk/src/client.js";

test("the daemon seals the explicit project policy and resolves local state beneath that project", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-runtime-policy-"));
  const policyDirectory = join(projectRoot, ".jevyr");
  await mkdir(policyDirectory);
  const search = structuredClone(DEFAULT_SEARCH_PROFILE);
  search.attemptSafetyCeiling = "999999999999999999999999999999999999";
  search.resources.maxMindInvocations = 7;
  search.resources.maxInputTokens = 12_345;
  search.resources.maxWritableBytes = 765_432;
  search.resources.maxWritableInodes = 432;
  search.resources.maxArtifactBytes = 54_321;
  await writeFile(join(policyDirectory, "policy.json"), `${JSON.stringify({
    protocol: "jevyr.policy/1",
    policyVersion: "bone-v1",
    semanticContinuation: false,
    reflex: { required: true, maximumLoops: 1 },
    forge: {
      network: "denied",
      source: "read_only",
      missingDocker: "UNPROVEN",
      limits: { maxProcessOutputBytes: 345_678, workspacePollIntervalMs: 321 },
    },
    memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 },
    growth: { liveBoneMutation: false, promotion: "signed_governance" },
    search,
  }, null, 2)}\n`, "utf8");
  const runtime = createDaemonRuntime({
    projectRoot,
    dataDir: "state",
    env: {},
    minds: [new RuleMindAdapter()],
    dockerImageResolver: () => ({ status: "unavailable", failure: "inspect-failed" }),
  });
  try {
    await runtime.ready();
    assert.equal(runtime.projectRoot, projectRoot);
    assert.equal(runtime.repository.dataDir, join(projectRoot, "state"));
    assert.equal(runtime.repository.searchEnvelope.profile.attemptSafetyCeiling, search.attemptSafetyCeiling);
    assert.equal(runtime.repository.searchEnvelope.profile.resources.maxMindInvocations, 7);
    assert.equal(runtime.repository.searchEnvelope.profile.resources.maxInputTokens, 12_345);
    assert.equal(runtime.repository.searchEnvelope.profile.resources.maxArtifactBytes, 54_321);
    assert.equal(runtime.forge.capability.limits?.maxWritableBytes, 765_432);
    assert.equal(runtime.forge.capability.limits?.maxWritableInodes, 432);
    assert.equal(runtime.forge.capability.limits?.maxProcessOutputBytes, 345_678);
    assert.equal(runtime.forge.capability.limits?.workspacePollIntervalMs, 321);
    const repositoryDescriptor = runtime.repository.policyDescriptor as Record<string, unknown>;
    const effective = (repositoryDescriptor.policy as Record<string, unknown>).effectiveForgeConfig as Record<string, unknown>;
    assert.equal(effective.maxWritableBytes, 765_432);
    assert.equal(effective.maxWritableInodes, 432);
    assert.equal(effective.maxProcessOutputBytes, 345_678);
    assert.equal(effective.workspacePollIntervalMs, 321);
    assert.match(JSON.stringify(runtime.repository.policyDescriptor), /jevyr\.project-policy-descriptor\/1/u);
    assert.match(JSON.stringify(runtime.repository.policyDescriptor), /mcpWitnessDigest/u);
    assert.equal(effective.mode, "observe-only");
    const preflight = (repositoryDescriptor.policy as Record<string, unknown>).forgePreflight as Record<string, unknown>;
    assert.equal(preflight.decision, "observe-only-before-seal");
    const substrate = preflight.requestedSubstrate as Record<string, unknown>;
    assert.equal(substrate.requestedReference, "node:24-alpine");
    assert.equal(substrate.status, "unavailable");
    assert.equal(substrate.immutableImageId, null);
    assert.equal(substrate.resolutionAuthority, "embedder-injected-resolver");
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("daemon seals one immutable Docker image identity and never consults the mutable tag again", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-runtime-docker-substrate-"));
  const imageId = `sha256:${"a".repeat(64)}`;
  let resolverCalls = 0;
  const runtime = createDaemonRuntime({
    projectRoot,
    dataDir: "state",
    env: {},
    minds: [new RuleMindAdapter()],
    forgeConfig: { dockerCommand: process.execPath, dockerImage: "registry.example/jevyr:stable" },
    dockerImageResolver: (request) => {
      resolverCalls += 1;
      assert.equal(request.dockerCommand, process.execPath);
      assert.equal(request.requestedReference, "registry.example/jevyr:stable");
      return { status: "resolved", imageId };
    },
  });
  try {
    const forge = runtime.forge as SealedForgeAdapter;
    assert.equal(resolverCalls, 1);
    assert.equal(forge.capability.canExecuteTools, true);
    assert.equal(forge.dockerSubstrateIdentity?.immutableImageId, imageId);

    const repositoryDescriptor = runtime.repository.policyDescriptor as Record<string, unknown>;
    const effectivePolicy = repositoryDescriptor.policy as Record<string, unknown>;
    assert.deepEqual(effectivePolicy.forgeSubstrateIdentity, {
      protocol: "jevyr.forge-substrate-binding/1",
      adapterBoundary: "built-in",
      mode: "docker",
      requestedReference: "registry.example/jevyr:stable",
      status: "resolved",
      immutableImageId: imageId,
      resolutionAuthority: "embedder-injected-resolver",
      failure: null,
    });

    // The probe addresses the sealed ID through a shell-free argv call. It may
    // fail under this fake command, but it cannot ask the resolver/tag again.
    const probe = await forge.probe();
    assert.equal(probe.available, false);
    assert.equal(resolverCalls, 1);
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("an unavailable startup image remains non-executing until daemon restart", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-runtime-docker-unavailable-"));
  let resolverCalls = 0;
  let imageAppeared = false;
  const runtime = createDaemonRuntime({
    projectRoot,
    dataDir: "state",
    env: {},
    minds: [new RuleMindAdapter()],
    dockerImageResolver: () => {
      resolverCalls += 1;
      return imageAppeared
        ? { status: "resolved", imageId: `sha256:${"b".repeat(64)}` }
        : { status: "unavailable", failure: "inspect-failed" };
    },
  });
  try {
    imageAppeared = true;
    assert.equal(runtime.forge.capability.canExecuteTools, false);
    const observation = await runtime.forge.execute({
      invocationId: "invocation_startup_unavailable",
      caseId: "case_startup_unavailable_12345678",
      tool: "forge.command",
      args: { command: "node", args: ["--version"] },
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    assert.equal(observation.status, "not-executed");
    assert.equal(observation.metadata?.reason, "observe-only");
    assert.equal(resolverCalls, 1);
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

for (const missingDocker of ["UNPROVEN", "INVALID"] as const) test(`preflight preserves explicit ${missingDocker} policy while never granting a host fallback`, async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-preflight-policy-"));
  await mkdir(join(projectRoot, ".jevyr"));
  await writeFile(join(projectRoot, ".jevyr", "policy.json"), JSON.stringify({ protocol: "jevyr.policy/1", policyVersion: "bone-v1", semanticContinuation: false,
    reflex: { required: true, maximumLoops: 1 }, forge: { network: "denied", source: "read_only", missingDocker }, memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 }, growth: { liveBoneMutation: false, promotion: "signed_governance" } }));
  const runtime = createDaemonRuntime({ projectRoot, dataDir: "state", env: {}, minds: [new RuleMindAdapter()], dockerImageResolver: () => ({ status: "unavailable", failure: "inspect-failed" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const draft = await client.createDraft({ case: { impulse: "Create a program. `node jevyr.experiment.mjs` exits with code 0.", control: "sovereign", privacy: "local_only" } });
    const tool = draft.startup.capabilities.find(capability => capability.kind === "tool");
    assert.equal(tool?.canExecuteTools, false);
    const preflight = (runtime.repository.policyDescriptor as any).policy.forgePreflight;
    assert.equal(preflight.missingSecureExecution, missingDocker);
    assert.equal(preflight.decision, missingDocker === "UNPROVEN" ? "observe-only-before-seal" : "retain-requested-body");
    const sealed = await client.sealDraft(draft.draftId, draft.revision, draft.startup.policyDigest);
    const result = await client.waitForAuthenticatedRecord(sealed.receipt!.caseId);
    assert.equal(result.payload.verdict.integrity, missingDocker === "UNPROVEN" ? "VALID" : "INVALID");
    assert.equal(result.payload.verdict.judgment, missingDocker === "UNPROVEN" ? "UNPROVEN" : "NOT_APPLICABLE");
    const events = await runtime.events.read(sealed.receipt!.caseId);
    assert.equal(events.some(event => event.kind === "action.status" && event.payload.actionType === "integrity.sandbox_failure"), missingDocker === "INVALID");
  } finally { await service.close(); await rm(projectRoot, { recursive: true, force: true }); }
});

test("embedder physical-limit overrides are snapshotted, enforced, and fully sealed in effective provenance", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-runtime-forge-override-"));
  const runtime = createDaemonRuntime({
    projectRoot,
    dataDir: "state",
    env: {
      JEVYR_FORGE_MAX_WRITABLE_BYTES: "9999999999",
      JEVYR_FORGE_MAX_PROCESS_OUTPUT_BYTES: "9999999999",
      JEVYR_FORGE_WORKSPACE_POLL_INTERVAL_MS: "60000",
    },
    minds: [new RuleMindAdapter()],
    forgeConfig: {
      mode: "observe-only",
      maxWritableBytes: 98_765,
      maxWritableInodes: 87,
      maxProcessOutputBytes: 7_654,
      workspacePollIntervalMs: 43,
    },
  });
  try {
    await runtime.ready();
    assert.equal(runtime.forge.capability.limits?.maxWritableBytes, 98_765);
    assert.equal(runtime.forge.capability.limits?.maxWritableInodes, 87);
    assert.equal(runtime.forge.capability.limits?.maxProcessOutputBytes, 7_654);
    assert.equal(runtime.forge.capability.limits?.workspacePollIntervalMs, 43);

    const repositoryDescriptor = runtime.repository.policyDescriptor as Record<string, unknown>;
    const effectivePolicy = repositoryDescriptor.policy as Record<string, unknown>;
    const embedder = effectivePolicy.embedderForgeConfig as Record<string, unknown>;
    const effective = effectivePolicy.effectiveForgeConfig as Record<string, unknown>;
    for (const [key, expected] of Object.entries({
      maxWritableBytes: 98_765,
      maxWritableInodes: 87,
      maxProcessOutputBytes: 7_654,
      workspacePollIntervalMs: 43,
    })) {
      assert.equal(embedder[key], expected, `embedder descriptor ${key}`);
      assert.equal(effective[key], expected, `effective descriptor ${key}`);
    }
    assert.equal(JSON.stringify(effectivePolicy).includes("9999999999"), false);
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("daemon rejects malformed, aliased, accessor-backed, or ambiguously targeted Forge overrides", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-runtime-forge-adversarial-"));
  const base = { projectRoot, dataDir: "state", env: {}, minds: [new RuleMindAdapter()] };
  try {
    assert.throws(
      () => createDaemonRuntime({
        ...base,
        forgeConfig: { maxProcessOutputBytes: Number.NaN } as never,
      }),
      /forgeConfig\.maxProcessOutputBytes must be a safe integer/u,
    );
    assert.throws(
      () => createDaemonRuntime({
        ...base,
        forgeConfig: { maxOutputBytes: 10 } as never,
      }),
      /forgeConfig\.maxOutputBytes is not a recognized daemon Forge input/u,
    );
    assert.throws(
      () => createDaemonRuntime({
        ...base,
        forgeConfig: { artifactExporter: async () => [] } as never,
      }),
      /forgeConfig\.artifactExporter is not a recognized daemon Forge input/u,
    );

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "maxWritableBytes", { enumerable: true, get: () => 10 });
    assert.throws(
      () => createDaemonRuntime({ ...base, forgeConfig: accessor as never }),
      /forgeConfig\.maxWritableBytes must be an inert data property/u,
    );

    assert.throws(
      () => createDaemonRuntime({
        ...base,
        forge: new SealedForgeAdapter({ mode: "observe-only" }),
        forgeConfig: { maxWritableBytes: 10 },
      }),
      /forge and forgeConfig cannot both be supplied/u,
    );
    assert.throws(
      () => createDaemonRuntime({
        ...base,
        forge: new SealedForgeAdapter({ mode: "observe-only" }),
        dockerImageResolver: () => ({ status: "resolved", imageId: `sha256:${"c".repeat(64)}` }),
      }),
      /forge and dockerImageResolver cannot both be supplied/u,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("an opaque embedder Forge is sealed as unverified instead of receiving a fabricated Docker identity", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-runtime-opaque-forge-"));
  const runtime = createDaemonRuntime({
    projectRoot,
    dataDir: "state",
    env: {},
    minds: [new RuleMindAdapter()],
    forge: new SealedForgeAdapter({ mode: "observe-only" }),
  });
  try {
    const repositoryDescriptor = runtime.repository.policyDescriptor as Record<string, unknown>;
    const effectivePolicy = repositoryDescriptor.policy as Record<string, unknown>;
    assert.deepEqual(effectivePolicy.forgeSubstrateIdentity, {
      protocol: "jevyr.forge-substrate-binding/1",
      adapterBoundary: "opaque-embedder",
      mode: null,
      requestedReference: null,
      status: "opaque-adapter",
      immutableImageId: null,
      resolutionAuthority: "adapter-defined-unverified",
      failure: null,
    });
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("daemon policy and later consumers retain one admitted Mind capability snapshot", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-runtime-capability-snapshot-"));
  const mind = new RuleMindAdapter();
  const runtime = createDaemonRuntime({
    projectRoot,
    dataDir: "state",
    env: {},
    minds: [mind],
    forgeConfig: { mode: "observe-only" },
  });
  try {
    const live = mind.capability as unknown as Record<string, unknown>;
    live.id = "mind.policy.mutated";
    live.version = "999";
    live.network = "unrestricted";

    const repositoryDescriptor = runtime.repository.policyDescriptor as Record<string, unknown>;
    const effectivePolicy = repositoryDescriptor.policy as Record<string, unknown>;
    assert.deepEqual(effectivePolicy.mindCapabilities, [{
      id: "mind.rule.v1",
      version: "1.0.0",
      transport: "in-process",
      trust: "local-deterministic",
      network: "none",
      canExecuteTools: false,
      limits: { maxContributions: 6 },
    }]);
    assert.equal(adapterCapabilitySnapshot(mind).id, "mind.rule.v1");
    assert.equal(adapterCapabilitySnapshot(mind).network, "none");
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("daemon capability admission does not invoke a hostile card accessor", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-runtime-capability-accessor-"));
  let reads = 0;
  const card: Record<string, unknown> = {
    id: "mind.hostile-card",
    kind: "mind",
    displayName: "Hostile card",
    version: "1",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: ["text"],
    network: "none",
    canExecuteTools: false,
    deterministic: true,
  };
  Object.defineProperty(card, "network", {
    enumerable: true,
    get() {
      reads += 1;
      return "none";
    },
  });
  const mind = {
    capability: card as unknown as CapabilityCard,
    async probe() {
      throw new Error("probe must not run");
    },
    async *run() {
      throw new Error("run must not run");
    },
  } as MindAdapter;
  try {
    assert.throws(
      () => createDaemonRuntime({
        projectRoot,
        dataDir: "state",
        env: {},
        minds: [mind],
        forgeConfig: { mode: "observe-only" },
      }),
      /CapabilityCard\.network must be an enumerable own data property/u,
    );
    assert.equal(reads, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
