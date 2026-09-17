import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE, FORGE_LIMIT_BOUNDS } from "@jevyr/runtime";
import { loadProjectPolicy, projectPolicyPath } from "../src/project-policy.js";

function basePolicy(): Record<string, unknown> {
  return {
    protocol: "jevyr.policy/1",
    policyVersion: "bone-v1",
    semanticContinuation: false,
    reflex: { required: true, maximumLoops: 2 },
    forge: { network: "denied", source: "read_only", missingDocker: "UNPROVEN" },
    memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 },
    growth: { liveBoneMutation: false, promotion: "signed_governance" },
  };
}

async function writePolicy(root: string, value: unknown): Promise<void> {
  const path = join(root, ".jevyr", "policy.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("project policy lookup is rooted exactly and never inherits a parent policy", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jevyr-project-policy-root-"));
  const child = join(parent, "nested", "project");
  try {
    await mkdir(child, { recursive: true });
    await writePolicy(parent, { ...basePolicy(), reflex: { required: true, maximumLoops: 1 } });

    const loaded = loadProjectPolicy(child);
    assert.equal(loaded.source, "built-in-default");
    assert.equal(loaded.projectRoot, child);
    assert.equal(loaded.policyPath, join(child, ".jevyr", "policy.json"));
    assert.equal(projectPolicyPath(child), loaded.policyPath);
    assert.equal(loaded.reflexLoops, 2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("project policy rejects malformed UTF-8 and duplicate control keys before normalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-project-policy-bytes-"));
  const path = join(root, ".jevyr", "policy.json");
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      '{"protocol":"jevyr.policy/0","protocol":"jevyr.policy/1","policyVersion":"bone-v1"}',
      "utf8",
    );
    assert.throws(() => loadProjectPolicy(root), /duplicate object key "protocol"/u);

    const encoded = Buffer.from(JSON.stringify({ ...basePolicy(), note: "hostile-byte" }), "utf8");
    const marker = encoded.indexOf("hostile-byte");
    assert.ok(marker >= 0);
    encoded[marker] = 0xff;
    await writeFile(path, encoded);
    assert.throws(() => loadProjectPolicy(root), /not valid UTF-8/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader produces portable canonical descriptor and only concrete runtime inputs", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "jevyr-project-policy-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "jevyr-project-policy-b-"));
  const search = structuredClone(DEFAULT_SEARCH_PROFILE);
  search.attemptSafetyCeiling = "1500000000000000000000";
  search.resources.maxWritableBytes = 7_654_321;
  search.resources.maxWritableInodes = 321;
  search.resources.maxArtifactBytes = 123_456;
  const policy = {
    ...basePolicy(),
    search,
    subjectSnapshots: {
      maxDirectoryFiles: 8_000,
      maxDirectoryBytes: 90_000_000,
      maxGitOutputBytes: 12_000_000,
      gitCommand: "git",
      url: {
        mode: "fetch",
        allowedOrigins: ["https://example.com", "https://example.com"],
        maxBytes: 2_000_000,
        timeoutMs: 5_000,
        maxRedirects: 1,
      },
    },
    forge: {
      missingDocker: "UNPROVEN",
      source: "read_only",
      network: "denied",
      mode: "docker",
      dockerImage: "node:24-alpine",
      limits: {
        cpus: 1.5,
        memoryMb: 768,
        pidsLimit: 128,
        maxFiles: 4_000,
        maxFileBytes: 3_000_000,
        maxProcessOutputBytes: 456_789,
        workspacePollIntervalMs: 250,
      },
    },
  };
  try {
    await writePolicy(firstRoot, policy);
    // Different insertion order and checkout path must not alter the portable descriptor.
    await writePolicy(secondRoot, {
      growth: policy.growth,
      memory: policy.memory,
      forge: policy.forge,
      reflex: policy.reflex,
      semanticContinuation: policy.semanticContinuation,
      subjectSnapshots: policy.subjectSnapshots,
      search: policy.search,
      policyVersion: policy.policyVersion,
      protocol: policy.protocol,
    });
    const first = loadProjectPolicy(firstRoot);
    const second = loadProjectPolicy(secondRoot);

    assert.equal(first.source, "project-file");
    assert.equal(first.policy.search.attemptSafetyCeiling, "1500000000000000000000");
    assert.equal(first.searchProfile, first.repositorySealProfile.searchProfile);
    assert.deepEqual(first.subjectSnapshotPolicy.url.allowedOrigins, ["https://example.com"]);
    assert.deepEqual(first.forgeConfig, {
      mode: "docker",
      allowTrustedHost: false,
      allowNetwork: false,
      dockerImage: "node:24-alpine",
      memoryMb: 768,
      cpus: 1.5,
      pidsLimit: 128,
      maxFiles: 4_000,
      maxFileBytes: 3_000_000,
      maxWritableBytes: 7_654_321,
      maxWritableInodes: 321,
      maxProcessOutputBytes: 456_789,
      workspacePollIntervalMs: 250,
      retainFailedWorkspace: false,
    });
    assert.equal(first.descriptorDigest, digestJson(first.policyDescriptor));
    assert.deepEqual(first.policyDescriptor, second.policyDescriptor);
    assert.equal(first.descriptorDigest, second.descriptorDigest);
    assert.equal(JSON.stringify(first.policyDescriptor).includes(firstRoot), false);
    assert.ok(first.enforcement.operationalInputPaths.includes("search.resources.maxInputTokens"));
    assert.ok(first.enforcement.operationalInputPaths.includes("search.resources.maxOutputTokens"));
    assert.ok(first.enforcement.operationalInputPaths.includes("search.resources.maxMindInvocations"));
    assert.ok(first.enforcement.operationalInputPaths.includes("search.resources.maxWritableBytes"));
    assert.ok(first.enforcement.operationalInputPaths.includes("search.resources.maxWritableInodes"));
    assert.ok(first.enforcement.operationalInputPaths.includes("search.resources.maxArtifactBytes"));
    assert.equal(first.enforcement.operationalInputPaths.includes("search.resources.maxForgeCpuMillis"), false);
    assert.ok(first.enforcement.operationalInputPaths.includes("search.resources.maxTotalAssayCost"));
    assert.ok(first.enforcement.operationalInputPaths.includes("forge.limits.maxProcessOutputBytes"));
    assert.ok(first.enforcement.operationalInputPaths.includes("forge.limits.workspacePollIntervalMs"));
    assert.equal(first.enforcement.sealedDeclarationOnlyPaths.includes("search.resources.maxArtifactBytes"), false);
    assert.ok(first.enforcement.sealedDeclarationOnlyPaths.includes("search.resources.maxForgeCpuMillis"));
    assert.equal(first.enforcement.sealedDeclarationOnlyPaths.includes("search.resources.maxTotalAssayCost"), false);
    assert.ok(first.enforcement.validatedInvariants.includes("semanticContinuation=false"));
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("unknown fields and malformed types are rejected at their exact paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-project-policy-strict-"));
  try {
    await writePolicy(root, { ...basePolicy(), pleasingOverride: true });
    assert.throws(() => loadProjectPolicy(root), /\$\.pleasingOverride is not a recognized policy field/u);

    await writePolicy(root, { ...basePolicy(), forge: { network: "denied", source: "read_only", missingDocker: "UNPROVEN", limits: { cpus: "many" } } });
    assert.throws(() => loadProjectPolicy(root), /\$\.forge\.limits\.cpus must be a finite number/u);

    await writePolicy(root, { ...basePolicy(), reflex: { required: true, maximumLoops: 1.5 } });
    assert.throws(() => loadProjectPolicy(root), /\$\.reflex\.maximumLoops must be a safe integer/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("physical Forge policy rejects aliases, malformed values, and values beyond the shared hard bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-project-policy-physical-"));
  const withForgeLimits = (limits: Record<string, unknown>): Record<string, unknown> => ({
    ...basePolicy(),
    forge: {
      network: "denied",
      source: "read_only",
      missingDocker: "UNPROVEN",
      limits,
    },
  });
  try {
    await writePolicy(root, withForgeLimits({ maxProcessOutputBytes: -1 }));
    assert.throws(() => loadProjectPolicy(root), /\$\.forge\.limits\.maxProcessOutputBytes must be a safe integer/u);

    await writePolicy(root, withForgeLimits({
      maxProcessOutputBytes: FORGE_LIMIT_BOUNDS.maxProcessOutputBytes.maximum + 1,
    }));
    assert.throws(() => loadProjectPolicy(root), /\$\.forge\.limits\.maxProcessOutputBytes must be a safe integer/u);

    await writePolicy(root, withForgeLimits({ workspacePollIntervalMs: 9 }));
    assert.throws(() => loadProjectPolicy(root), /\$\.forge\.limits\.workspacePollIntervalMs must be a safe integer/u);

    await writePolicy(root, withForgeLimits({
      workspacePollIntervalMs: FORGE_LIMIT_BOUNDS.workspacePollIntervalMs.maximum + 1,
    }));
    assert.throws(() => loadProjectPolicy(root), /\$\.forge\.limits\.workspacePollIntervalMs must be a safe integer/u);

    await writePolicy(root, withForgeLimits({ maxOutputBytes: 10 }));
    assert.throws(() => loadProjectPolicy(root), /\$\.forge\.limits\.maxOutputBytes is not a recognized policy field/u);

    await writePolicy(root, {
      ...basePolicy(),
      forge: {
        network: "denied",
        source: "read_only",
        missingDocker: "UNPROVEN",
        maxWritableBytes: 10,
      },
    });
    assert.throws(() => loadProjectPolicy(root), /\$\.forge\.maxWritableBytes is not a recognized policy field/u);

    const excessiveBytes = structuredClone(DEFAULT_SEARCH_PROFILE);
    excessiveBytes.resources.maxWritableBytes = FORGE_LIMIT_BOUNDS.maxWritableBytes.maximum + 1;
    await writePolicy(root, { ...basePolicy(), search: excessiveBytes });
    assert.throws(() => loadProjectPolicy(root), /\$\.search\.resources\.maxWritableBytes must be a safe integer/u);

    const excessiveInodes = structuredClone(DEFAULT_SEARCH_PROFILE);
    excessiveInodes.resources.maxWritableInodes = FORGE_LIMIT_BOUNDS.maxWritableInodes.maximum + 1;
    await writePolicy(root, { ...basePolicy(), search: excessiveInodes });
    assert.throws(() => loadProjectPolicy(root), /\$\.search\.resources\.maxWritableInodes must be a safe integer/u);

    const hiddenAlias = structuredClone(DEFAULT_SEARCH_PROFILE) as unknown as Record<string, unknown>;
    (hiddenAlias.resources as Record<string, unknown>).workspacePollIntervalMs = 100;
    await writePolicy(root, { ...basePolicy(), search: hiddenAlias });
    assert.throws(
      () => loadProjectPolicy(root),
      /\$\.search\.resources\.workspacePollIntervalMs is not a recognized policy field/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("constitutional invariants fail closed when a file tries to weaken or over-promise them", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-project-policy-invariants-"));
  const mutations: readonly [string, (policy: Record<string, unknown>) => void][] = [
    ["semanticContinuation", (policy) => { policy.semanticContinuation = true; }],
    ["reflex.required", (policy) => { policy.reflex = { required: false, maximumLoops: 2 }; }],
    ["reflex.maximumLoops", (policy) => { policy.reflex = { required: true, maximumLoops: 3 }; }],
    ["forge.mode", (policy) => { policy.forge = { network: "denied", source: "read_only", missingDocker: "UNPROVEN", mode: "trusted-host" }; }],
    ["forge.network", (policy) => { policy.forge = { network: "enabled", source: "read_only", missingDocker: "UNPROVEN" }; }],
    ["forge.source", (policy) => { policy.forge = { network: "denied", source: "read_write", missingDocker: "UNPROVEN" }; }],
    ["forge.missingDocker", (policy) => { policy.forge = { network: "denied", source: "read_only", missingDocker: "trusted_host" }; }],
    ["memory.firstWave", (policy) => { policy.memory = { firstWave: "informed", maximumLateInfluence: 0.2 }; }],
    ["memory.maximumLateInfluence", (policy) => { policy.memory = { firstWave: "amnesic", maximumLateInfluence: 0.1 }; }],
    ["growth.liveBoneMutation", (policy) => { policy.growth = { liveBoneMutation: true, promotion: "signed_governance" }; }],
    ["growth.promotion", (policy) => { policy.growth = { liveBoneMutation: false, promotion: "automatic" }; }],
  ];
  try {
    for (const [path, mutate] of mutations) {
      const policy = basePolicy();
      mutate(policy);
      await writePolicy(root, policy);
      assert.throws(() => loadProjectPolicy(root), new RegExp(path.replace(".", "\\."), "u"), path);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit search policy is exhaustive and numerically safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-project-policy-search-"));
  try {
    const missingResource = structuredClone(DEFAULT_SEARCH_PROFILE) as unknown as Record<string, unknown>;
    const resources = missingResource.resources as Record<string, unknown>;
    delete resources.maxInputTokens;
    await writePolicy(root, { ...basePolicy(), search: missingResource });
    assert.throws(() => loadProjectPolicy(root), /\$\.search\.resources\.maxInputTokens is required/u);

    const unsafe = structuredClone(DEFAULT_SEARCH_PROFILE);
    unsafe.resources.maxOutputTokens = Number.MAX_SAFE_INTEGER + 1;
    await writePolicy(root, { ...basePolicy(), search: unsafe });
    assert.throws(() => loadProjectPolicy(root), /\$\.search\.resources\.maxOutputTokens must be a safe integer/u);

    const impossible = structuredClone(DEFAULT_SEARCH_PROFILE);
    impossible.attemptSafetyCeiling = "2";
    impossible.nursery.minimumAttempts = 3;
    await writePolicy(root, { ...basePolicy(), search: impossible });
    assert.throws(() => loadProjectPolicy(root), /minimumAttempts cannot exceed/u);

    const networkClaim = structuredClone(DEFAULT_SEARCH_PROFILE);
    networkClaim.resources.maxNetworkBytes = 1;
    await writePolicy(root, { ...basePolicy(), search: networkClaim });
    assert.throws(() => loadProjectPolicy(root), /maxNetworkBytes must be zero/u);

    const hugeButCanonical = structuredClone(DEFAULT_SEARCH_PROFILE);
    hugeButCanonical.attemptSafetyCeiling = "9".repeat(128);
    await writePolicy(root, { ...basePolicy(), search: hugeButCanonical });
    assert.equal(loadProjectPolicy(root).searchProfile.attemptSafetyCeiling, "9".repeat(128));

    const tooManyDigits = structuredClone(DEFAULT_SEARCH_PROFILE);
    tooManyDigits.attemptSafetyCeiling = "9".repeat(129);
    await writePolicy(root, { ...basePolicy(), search: tooManyDigits });
    assert.throws(() => loadProjectPolicy(root), /at most 128 digits/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor is plain canonical JSON without functions or machine-local provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-project-policy-json-"));
  try {
    await writePolicy(root, basePolicy());
    const loaded = loadProjectPolicy(root);
    const roundTrip = JSON.parse(JSON.stringify(loaded.policyDescriptor)) as JsonValue;
    assert.deepEqual(roundTrip, loaded.policyDescriptor);
    assert.equal(digestJson(roundTrip), loaded.descriptorDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
