import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JEVYR_BONE_DIGEST, generateSigningKeyPair } from "@jevyr/core";
import {
  GENOME_PROTOCOL,
  GenomeRegistry,
  createDescendant,
  createGenome,
  builtinGenomeModule,
  promoteGenome,
  signGenomePromotion,
  stageDescendant,
  type StoredGenome,
} from "@jevyr/growth";
import { sha256Digest } from "@jevyr/protocol";
import { DEFAULT_GENOME_DESCRIPTOR, RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";

function rootGenome(boneDigest = JEVYR_BONE_DIGEST): StoredGenome {
  return createGenome({
    protocol: GENOME_PROTOCOL,
    generation: 0,
    boneDigest,
    parentDigests: [],
    modules: [
      builtinGenomeModule("jevyr.nursery-governor"),
      builtinGenomeModule("jevyr.archive-curator"),
      builtinGenomeModule("jevyr.late-memory-gate"),
    ],
    parameters: {
      "jevyr.nursery-governor": { saturationWindow: 120, challengeInterval: 12 },
      "jevyr.archive-curator": { capacity: 256, minimumNovelty: 0.05 },
      "jevyr.late-memory-gate": { recallLimit: 8, weight: 0.15 },
    },
  });
}

function acceptedEvidence(label: string) {
  const benchmarks = [
    "bone-invariants",
    "historical-regressions",
    "held-out-adversarial",
    "anchoring-contamination",
    "resource-bounds",
  ].map((suite) => ({
    suite,
    heldOut: suite === "held-out-adversarial",
    invariant: suite === "bone-invariants",
    passed: true,
    score: suite === "held-out-adversarial" ? 0.95 : 1,
    parentScore: suite === "held-out-adversarial" ? 0.8 : 1,
    evidenceDigest: sha256Digest(`${label}:${suite}`),
  }));
  const damage = (["CORRUPTION", "RESOURCE_LOSS", "ADVERSARIAL_INPUT", "TOOL_LOSS"] as const).map((kind) => ({
    id: `${label}:${kind}`,
    kind,
    passed: true,
    recoveredToBone: true,
    evidenceDigest: sha256Digest(`${label}:damage:${kind}`),
  }));
  return { benchmarks, damage };
}

async function promoteNext(
  registry: GenomeRegistry,
  parent: StoredGenome,
  label: string,
  authority: ReturnType<typeof generateSigningKeyPair>,
): Promise<StoredGenome> {
  const first = label === "first" || label === "untrusted";
  const descendant = createDescendant(parent, {
    parameters: {
      "jevyr.nursery-governor": {
        saturationWindow: first ? 80 : 40,
        challengeInterval: first ? 8 : 4,
      },
      "jevyr.archive-curator": {
        capacity: first ? 128 : 64,
        minimumNovelty: first ? 0.08 : 0.12,
      },
      "jevyr.late-memory-gate": {
        recallLimit: first ? 5 : 2,
        weight: first ? 0.12 : 0.05,
      },
    },
  });
  const evidence = acceptedEvidence(label);
  const proposal = stageDescendant(parent, descendant, evidence.benchmarks, evidence.damage, 0.5);
  assert.equal(proposal.decision, "STAGED");
  await registry.storeGenome(parent);
  await registry.storeGenome(descendant);
  await registry.storeProposal(proposal);
  const keys = new Map([[authority.keyId, authority.publicKeyPem]]);
  const attestation = signGenomePromotion(proposal, authority.privateKeyPem, authority.keyId);
  const promoted = promoteGenome(proposal, attestation, keys);
  const stored = await registry.storePromotion(promoted, keys);
  await registry.activatePromotion(stored.digest, keys);
  return descendant;
}

function runtimeOptions(projectRoot: string, dataDir: string, trustFile?: string) {
  return {
    projectRoot,
    dataDir,
    env: trustFile === undefined ? {} : { JEVYR_GENOME_GOVERNANCE_TRUST_FILE: trustFile },
    minds: [new RuleMindAdapter()],
    forge: new SealedForgeAdapter({ mode: "observe-only" as const }),
  };
}

test("startup binds an explicit baseline when the registry has no active pointer", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-genome-baseline-"));
  const dataDir = join(projectRoot, "state");
  const runtime = createDaemonRuntime(runtimeOptions(projectRoot, dataDir));
  try {
    await runtime.ready();
    assert.equal(runtime.genome.source, "baseline");
    assert.equal(runtime.repository.genomeVersion, "jevyr.genome/1");
    assert.deepEqual(runtime.repository.genomeDescriptor, DEFAULT_GENOME_DESCRIPTOR);
    assert.equal(runtime.genome.descriptor.selection.mode, "baseline");
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("one verified active pointer snapshot binds every Case until a daemon restart", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-genome-restart-"));
  const dataDir = join(projectRoot, "state");
  const registry = new GenomeRegistry(join(dataDir, "genome-registry"));
  const authority = generateSigningKeyPair();
  const trustPath = join(projectRoot, "governance-trust.json");
  await writeFile(trustPath, `${JSON.stringify({
    protocol: "jevyr.genome-governance-trust/1",
    keys: [{ keyId: authority.keyId, algorithm: "Ed25519", publicKeyPem: authority.publicKeyPem }],
  }, null, 2)}\n`, "utf8");
  const firstGenome = await promoteNext(registry, rootGenome(), "first", authority);
  const first = createDaemonRuntime(runtimeOptions(projectRoot, dataDir, trustPath));
  let second: ReturnType<typeof createDaemonRuntime> | undefined;
  try {
    await first.ready();
    assert.equal(first.genome.source, "governance-promotion");
    assert.equal(first.repository.genomeVersion, GENOME_PROTOCOL);
    assert.equal(first.repository.genomeDigest, firstGenome.digest);
    assert.deepEqual(first.repository.genomeDescriptor, firstGenome.body);
    assert.equal(first.genome.runtimeProfile?.sourceGenomeDigest, firstGenome.digest);
    assert.equal(first.growthPolicy.archive.capacity, 128);
    assert.equal(first.growthPolicy.archive.minimumNovelty, 0.08);
    assert.equal(first.growthPolicy.lateMemory.recallLimit, 5);
    const beforeChange = await first.orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "This Case sees the startup Genome snapshot." },
    });
    assert.equal(beforeChange.sealed.genomeDigest, firstGenome.digest);

    const secondGenome = await promoteNext(registry, firstGenome, "second", authority);
    const afterPointerChange = await first.orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "A pointer change cannot enter this already-running daemon." },
    });
    assert.equal(afterPointerChange.sealed.genomeDigest, firstGenome.digest);
    assert.equal(first.repository.genomeDigest, firstGenome.digest);

    await first.close();
    second = createDaemonRuntime(runtimeOptions(projectRoot, dataDir, trustPath));
    await second.ready();
    assert.equal(second.repository.genomeDigest, secondGenome.digest);
    assert.deepEqual(second.repository.genomeDescriptor, secondGenome.body);
    assert.equal(second.growthPolicy.archive.capacity, 64);
    assert.equal(second.growthPolicy.archive.minimumNovelty, 0.12);
    assert.equal(second.growthPolicy.lateMemory.maximumWeight, 0.05);
    const futureCase = await second.orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "A restarted daemon binds the newly promoted Genome." },
    });
    assert.equal(futureCase.sealed.genomeDigest, secondGenome.digest);
    assert.notEqual(futureCase.sealed.runDigest, beforeChange.sealed.runDigest);
  } finally {
    await first.close();
    await second?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("active promotion fails closed without its exact governance trust key", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-genome-untrusted-"));
  const dataDir = join(projectRoot, "state");
  const registry = new GenomeRegistry(join(dataDir, "genome-registry"));
  const authority = generateSigningKeyPair();
  await promoteNext(registry, rootGenome(), "untrusted", authority);
  try {
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(projectRoot, dataDir)),
      /governance attestation is invalid/u,
    );
    // A failed startup releases its data-directory lease.
    const trustPath = join(projectRoot, "governance-trust.json");
    await writeFile(trustPath, JSON.stringify({
      protocol: "jevyr.genome-governance-trust/1",
      keys: [{ keyId: authority.keyId, algorithm: "Ed25519", publicKeyPem: authority.publicKeyPem }],
    }), "utf8");
    const trusted = createDaemonRuntime(runtimeOptions(projectRoot, dataDir, trustPath));
    await trusted.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a governance-valid Genome for another Bone fails before any CaseRepository can exist", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-genome-wrong-bone-"));
  const dataDir = join(projectRoot, "state");
  const registry = new GenomeRegistry(join(dataDir, "genome-registry"));
  const authority = generateSigningKeyPair();
  const trustPath = join(projectRoot, "governance-trust.json");
  await writeFile(trustPath, JSON.stringify({
    protocol: "jevyr.genome-governance-trust/1",
    keys: [{ keyId: authority.keyId, algorithm: "Ed25519", publicKeyPem: authority.publicKeyPem }],
  }), "utf8");
  await promoteNext(registry, rootGenome(sha256Digest("another-runtime-bone")), "wrong-bone", authority);
  try {
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(projectRoot, dataDir, trustPath)),
      /Bone digest does not match the runtime's expected Bone/u,
    );
    // Reaching the same compiler refusal, rather than the daemon-lease refusal,
    // proves failed startup released its exact data directory.
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(projectRoot, dataDir, trustPath)),
      /Bone digest does not match the runtime's expected Bone/u,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("governance trust config rejects unknown fields and private key material", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-genome-trust-strict-"));
  const dataDir = join(projectRoot, "state");
  const authority = generateSigningKeyPair();
  const trustPath = join(projectRoot, "governance-trust.json");
  try {
    await writeFile(trustPath, JSON.stringify({
      protocol: "jevyr.genome-governance-trust/1",
      keys: [{ keyId: authority.keyId, algorithm: "Ed25519", publicKeyPem: authority.publicKeyPem, permissive: true }],
    }), "utf8");
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(projectRoot, dataDir, trustPath)),
      /must contain exactly/u,
    );

    await writeFile(trustPath, JSON.stringify({
      protocol: "jevyr.genome-governance-trust/1",
      keys: [{ keyId: authority.keyId, algorithm: "Ed25519", publicKeyPem: authority.privateKeyPem }],
    }), "utf8");
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(projectRoot, dataDir, trustPath)),
      /public-key PEM block/u,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("governance trust bytes reject duplicate authority and malformed UTF-8 before repository startup", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jevyr-genome-trust-bytes-"));
  const dataDir = join(projectRoot, "state");
  const authority = generateSigningKeyPair();
  const trustPath = join(projectRoot, "governance-trust.json");
  try {
    await writeFile(
      trustPath,
      `{"protocol":"jevyr.genome-governance-trust/0","protocol":"jevyr.genome-governance-trust/1","keys":[${JSON.stringify({ keyId: authority.keyId, algorithm: "Ed25519", publicKeyPem: authority.publicKeyPem })}]}`,
      "utf8",
    );
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(projectRoot, dataDir, trustPath)),
      /duplicate object key "protocol"/u,
    );

    const encoded = Buffer.from(JSON.stringify({
      protocol: "jevyr.genome-governance-trust/1",
      keys: [{ keyId: authority.keyId, algorithm: "Ed25519", publicKeyPem: authority.publicKeyPem }],
    }), "utf8");
    const marker = encoded.indexOf("PUBLIC KEY");
    assert.ok(marker >= 0);
    encoded[marker] = 0xff;
    await writeFile(trustPath, encoded);
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(projectRoot, dataDir, trustPath)),
      /not valid UTF-8/u,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
