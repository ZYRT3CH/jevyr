import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKeyPair } from "@jevyr/core";
import { canonicalize, sha256Digest, type JsonValue } from "@jevyr/protocol";
import {
  GENOME_PROTOCOL,
  GenomeRegistry,
  GenomeRegistryGovernanceError,
  GenomeRegistryIntegrityError,
  createDescendant,
  createGenome,
  promoteGenome,
  signGenomePromotion,
  stageDescendant,
  type BenchmarkObservation,
  type DamageTrial,
  type GrowthProposal,
  type PromotedGenome,
  type StoredGenome,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-genome-registry-"));
  roots.push(root);
  return root;
}

function parentGenome(label = "one"): StoredGenome {
  return createGenome({
    protocol: GENOME_PROTOCOL,
    generation: 0,
    boneDigest: sha256Digest(`bone-${label}`),
    parentDigests: [],
    modules: [
      {
        id: "diverge",
        version: "1.0.0",
        artifactDigest: sha256Digest(`module-${label}`),
        permissions: ["propose"],
        publicPurpose: "Produce blind alternatives.",
      },
    ],
    parameters: { lineages: 8 },
  });
}

function benchmark(label = "one"): BenchmarkObservation[] {
  return [
    "bone-invariants",
    "historical-regressions",
    "held-out-adversarial",
    "anchoring-contamination",
    "resource-bounds",
  ].map((suite, index) => ({
    suite,
    heldOut: suite === "held-out-adversarial",
    invariant: suite === "bone-invariants",
    passed: true,
    score: index === 2 ? 0.92 : 1,
    parentScore: index === 2 ? 0.8 : 1,
    evidenceDigest: sha256Digest(`${label}-suite-${suite}`),
  }));
}

function damage(label = "one"): DamageTrial[] {
  return (["CORRUPTION", "RESOURCE_LOSS", "ADVERSARIAL_INPUT", "TOOL_LOSS"] as const)
    .map((kind, index) => ({
      id: `${label}-damage-${index}`,
      kind,
      passed: true,
      recoveredToBone: true,
      evidenceDigest: sha256Digest(`${label}-damage-${index}`),
    }));
}

function staged(parent: StoredGenome, label = "one"): GrowthProposal {
  const descendant = createDescendant(parent, {
    parameters: { lineages: 16, label },
  });
  return stageDescendant(parent, descendant, benchmark(label), damage(label), 0.3);
}

async function archiveLineage(registry: GenomeRegistry, proposal: GrowthProposal): Promise<void> {
  await registry.storeGenome(parentFromProposal(proposal));
  await registry.storeGenome(proposal.descendant);
  await registry.storeProposal(proposal);
}

// The proposal embeds only the child, so tests attach their known parent here.
const knownParents = new Map<string, StoredGenome>();
function remember(parent: StoredGenome): StoredGenome {
  knownParents.set(parent.digest, parent);
  return parent;
}
function parentFromProposal(proposal: GrowthProposal): StoredGenome {
  const parent = knownParents.get(proposal.parentDigest);
  if (parent === undefined) throw new Error("test parent was not registered");
  return parent;
}

function promotion(
  proposal: GrowthProposal,
  keys: ReturnType<typeof generateSigningKeyPair>,
): PromotedGenome {
  const attestation = signGenomePromotion(proposal, keys.privateKeyPem, keys.keyId);
  return promoteGenome(proposal, attestation, new Map([[keys.keyId, keys.publicKeyPem]]));
}

describe("durable Genome registry", () => {
  it("publishes immutable content once and returns verified, sorted snapshots", async () => {
    const root = await fixtureRoot();
    const registry = new GenomeRegistry(root);
    const later = remember(parentGenome("z"));
    const earlier = remember(parentGenome("a"));

    const writes = await Promise.all(
      Array.from({ length: 12 }, () => registry.storeGenome(later)),
    );
    expect(writes.filter((receipt) => receipt.status === "STORED")).toHaveLength(1);
    expect(writes.filter((receipt) => receipt.status === "ALREADY_PRESENT")).toHaveLength(11);
    await registry.storeGenome(earlier);

    const listed = await registry.listGenomes();
    expect(listed).toEqual([earlier.digest, later.digest].sort());
    expect(Object.isFrozen(listed)).toBe(true);

    const loaded = await registry.readGenome(later.digest);
    expect(loaded).toEqual(later);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.body.parameters)).toBe(true);
    const temporary = await readdir(join(root, "tmp"));
    expect(temporary).toEqual([]);
  });

  it("rejects caller digest mismatches before creating an address", async () => {
    const root = await fixtureRoot();
    const registry = new GenomeRegistry(root);
    const valid = parentGenome();
    const forged = {
      ...valid,
      digest: sha256Digest("forged-address"),
    } as StoredGenome;

    await expect(registry.storeGenome(forged)).rejects.toBeInstanceOf(GenomeRegistryIntegrityError);
    await expect(registry.listGenomes()).resolves.toEqual([]);
  });

  it("detects corrupted and non-canonical bytes and never overwrites them", async () => {
    const root = await fixtureRoot();
    const registry = new GenomeRegistry(root);
    const genome = parentGenome();
    await registry.storeGenome(genome);
    const path = join(root, "genomes", `${genome.digest.slice("sha256:".length)}.json`);
    const altered = `${canonicalize(genome as unknown as JsonValue)}\n`;
    await writeFile(path, altered, "utf8");

    await expect(registry.readGenome(genome.digest)).rejects.toBeInstanceOf(GenomeRegistryIntegrityError);
    await expect(registry.storeGenome(genome)).rejects.toThrow(/occupied by different or corrupt bytes/);
    await expect(readFile(path, "utf8")).resolves.toBe(altered);
    await expect(registry.listGenomes()).rejects.toBeInstanceOf(GenomeRegistryIntegrityError);
  });

  it("rejects duplicate controls and malformed UTF-8 before reconstructing a Genome", async () => {
    const root = await fixtureRoot();
    const registry = new GenomeRegistry(root);
    const genome = parentGenome("unambiguous");
    await registry.storeGenome(genome);
    const path = join(root, "genomes", `${genome.digest.slice("sha256:".length)}.json`);
    const canonical = canonicalize(genome as unknown as JsonValue);
    const duplicate = canonical.replace(
      '"protocol":"jevyr.genome/1"',
      '"protocol":"jevyr.genome/0","protocol":"jevyr.genome/1"',
    );
    expect(duplicate).not.toBe(canonical);
    await writeFile(path, duplicate, "utf8");
    await expect(registry.readGenome(genome.digest)).rejects.toThrow(/duplicate object key "protocol"/u);

    const malformed = Buffer.from(canonical, "utf8");
    const marker = malformed.indexOf("Produce blind alternatives.");
    expect(marker).toBeGreaterThanOrEqual(0);
    malformed[marker] = 0xff;
    await writeFile(path, malformed);
    await expect(registry.readGenome(genome.digest)).rejects.toThrow(/not valid UTF-8/u);
  });

  it("rejects malformed directory entries rather than hiding registry corruption", async () => {
    const root = await fixtureRoot();
    const registry = new GenomeRegistry(root);
    await registry.initialize();
    await writeFile(join(root, "genomes", "not-an-address.json"), "{}", "utf8");
    await expect(registry.listGenomes()).rejects.toThrow(/Unexpected entry/);
  });

  it("requires stored, matching lineage objects before archiving a proposal", async () => {
    const root = await fixtureRoot();
    const registry = new GenomeRegistry(root);
    const parent = remember(parentGenome());
    const proposal = staged(parent);

    await expect(registry.storeProposal(proposal)).rejects.toMatchObject({ code: "ENOENT" });
    await registry.storeGenome(parent);
    await registry.storeGenome(proposal.descendant);
    await expect(registry.storeProposal(proposal)).resolves.toMatchObject({ status: "STORED" });
    await expect(registry.readProposal(proposal.proposalDigest)).resolves.toEqual(proposal);

    const forged = {
      ...proposal,
      reasons: ["changed after staging"],
    } as GrowthProposal;
    await expect(registry.storeProposal(forged)).rejects.toThrow(/content address/);
  });

  it("stores and activates only a cryptographically governed promotion", async () => {
    const root = await fixtureRoot();
    const registry = new GenomeRegistry(root);
    const parent = remember(parentGenome());
    const proposal = staged(parent);
    await archiveLineage(registry, proposal);
    const authority = generateSigningKeyPair();
    const stranger = generateSigningKeyPair();
    const promoted = promotion(proposal, authority);
    const authorityKeys = new Map([[authority.keyId, authority.publicKeyPem]]);
    const strangerKeys = new Map([[stranger.keyId, stranger.publicKeyPem]]);

    await expect(registry.storePromotion(promoted, strangerKeys)).rejects.toBeInstanceOf(GenomeRegistryGovernanceError);
    await expect(registry.listPromotions()).resolves.toEqual([]);
    const stored = await registry.storePromotion(promoted, authorityKeys);
    expect(stored.status).toBe("STORED");

    await expect(registry.activatePromotion(stored.digest, strangerKeys)).rejects.toBeInstanceOf(GenomeRegistryGovernanceError);
    await expect(registry.readActive(authorityKeys)).resolves.toBeUndefined();
    const pointer = await registry.activatePromotion(stored.digest, authorityKeys);
    expect(pointer.body.genomeDigest).toBe(proposal.descendant.digest);

    const reopened = new GenomeRegistry(root);
    const active = await reopened.readActive(authorityKeys);
    expect(active?.genome).toEqual(proposal.descendant);
    expect(active?.promotion.digest).toBe(stored.digest);
    expect(Object.isFrozen(active?.pointer)).toBe(true);
    expect(Object.isFrozen(active?.genome.body)).toBe(true);
    expect(reopened.readActiveSync(authorityKeys)).toEqual(active);
  });

  it("leaves an established active pointer untouched after failed governance", async () => {
    const root = await fixtureRoot();
    const registry = new GenomeRegistry(root);
    const parent = remember(parentGenome());
    const proposal = staged(parent);
    await archiveLineage(registry, proposal);
    const authority = generateSigningKeyPair();
    const stranger = generateSigningKeyPair();
    const authorityKeys = new Map([[authority.keyId, authority.publicKeyPem]]);
    const stored = await registry.storePromotion(promotion(proposal, authority), authorityKeys);
    const before = await registry.activatePromotion(stored.digest, authorityKeys);

    await expect(
      registry.activatePromotion(stored.digest, new Map([[stranger.keyId, stranger.publicKeyPem]])),
    ).rejects.toBeInstanceOf(GenomeRegistryGovernanceError);
    const after = await registry.readActive(authorityKeys);
    expect(after?.pointer).toEqual(before);
  });

  it("rejects a promotion CAS mutation when reconstructing startup authority", async () => {
    const root = await fixtureRoot();
    const registry = new GenomeRegistry(root);
    const parent = remember(parentGenome());
    const proposal = staged(parent);
    await archiveLineage(registry, proposal);
    const authority = generateSigningKeyPair();
    const authorityKeys = new Map([[authority.keyId, authority.publicKeyPem]]);
    const stored = await registry.storePromotion(promotion(proposal, authority), authorityKeys);
    await registry.activatePromotion(stored.digest, authorityKeys);

    const path = join(root, "promotions", `${stored.digest.slice("sha256:".length)}.json`);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const body = record.body as Record<string, unknown>;
    body.promoted = false;
    await writeFile(path, canonicalize(record as JsonValue), "utf8");

    await expect(new GenomeRegistry(root).readActive(authorityKeys)).rejects.toBeInstanceOf(GenomeRegistryIntegrityError);
  });
});
