import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  adapterCapabilitySnapshot,
  CaseRepository,
  FileEventHub,
  JevyrOrchestrator,
  RuleMindAdapter,
  SealedForgeAdapter,
  snapshotAdapterCapability,
  snapshotCapabilityCard,
  type CapabilityCard,
  type MindAdapter,
  type MindRequest,
  type ProbeResult,
  type PublicContribution,
} from "../src/index.js";

function mutableCard(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "mind.mutable.original",
    kind: "mind",
    displayName: "Mutable original",
    version: "1.0.0",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: ["text", "structured-data"],
    network: "none",
    canExecuteTools: false,
    deterministic: true,
    limits: { maxContributions: 2 },
    ...overrides,
  };
}

test("capability admission snapshots and deeply freezes caller-owned card data exactly once", () => {
  const live = mutableCard();
  const adapter = { capability: live as unknown as CapabilityCard };
  const admitted = snapshotAdapterCapability(adapter);

  live.id = "mind.mutable.replaced";
  live.network = "unrestricted";
  (live.modalities as string[]).push("commands");
  (live.limits as Record<string, unknown>).maxContributions = 999;
  adapter.capability = mutableCard({ id: "mind.second-card" }) as unknown as CapabilityCard;

  assert.equal(adapterCapabilitySnapshot(adapter), admitted);
  assert.deepEqual(admitted, {
    id: "mind.mutable.original",
    kind: "mind",
    displayName: "Mutable original",
    version: "1.0.0",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: ["text", "structured-data"],
    network: "none",
    canExecuteTools: false,
    deterministic: true,
    limits: { maxContributions: 2 },
  });
  assert.equal(Object.isFrozen(admitted), true);
  assert.equal(Object.isFrozen(admitted.modalities), true);
  assert.equal(Object.isFrozen(admitted.limits), true);
});

test("capability admission rejects card and adapter accessors without invoking them", () => {
  let cardReads = 0;
  const hostileCard = mutableCard();
  Object.defineProperty(hostileCard, "network", {
    enumerable: true,
    get() {
      cardReads += 1;
      return "none";
    },
  });
  assert.throws(
    () => snapshotCapabilityCard(hostileCard),
    /CapabilityCard\.network must be an enumerable own data property/u,
  );
  assert.equal(cardReads, 0);

  let adapterReads = 0;
  const hostileAdapter = {};
  Object.defineProperty(hostileAdapter, "capability", {
    enumerable: true,
    get() {
      adapterReads += 1;
      return mutableCard();
    },
  });
  assert.throws(
    () => snapshotAdapterCapability(hostileAdapter as { readonly capability: CapabilityCard }),
    /Adapter capability must be an enumerable own data property/u,
  );
  assert.equal(adapterReads, 0);
});

test("capability admission rejects Proxies without executing capability traps", () => {
  let reads = 0;
  const hostileAdapter = new Proxy({ capability: mutableCard() as unknown as CapabilityCard }, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      reads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  assert.throws(() => snapshotAdapterCapability(hostileAdapter), /non-Proxy object/u);
  assert.equal(reads, 0);
});

test("capability admission enforces exact fields, enums, and collection shape", () => {
  assert.throws(
    () => snapshotCapabilityCard(mutableCard({ surprise: true })),
    /CapabilityCard\.surprise is not a recognized capability field/u,
  );
  assert.throws(
    () => snapshotCapabilityCard(mutableCard({ kind: "judge" })),
    /CapabilityCard\.kind is invalid/u,
  );
  assert.throws(
    () => snapshotCapabilityCard(mutableCard({ network: "sometimes" })),
    /CapabilityCard\.network is invalid/u,
  );
  assert.throws(
    () => snapshotCapabilityCard(mutableCard({ modalities: ["text", "text"] })),
    /CapabilityCard\.modalities must be unique/u,
  );
  assert.throws(
    () => snapshotCapabilityCard(mutableCard({ limits: undefined })),
    /CapabilityCard\.limits must be omitted or an exact limits object/u,
  );
});

test("orchestrator rejects duplicate admitted capability identities before Cast", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-capability-duplicate-"));
  try {
    assert.throws(
      () => new JevyrOrchestrator({
        repository: new CaseRepository(root),
        events: new FileEventHub(root),
        minds: [new RuleMindAdapter(), new RuleMindAdapter()],
        forge: new SealedForgeAdapter({ mode: "observe-only" }),
      }),
      /Configured adapter capability ids must be unique/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class MutableRemoteMind implements MindAdapter {
  runCalls = 0;

  constructor(readonly capability: CapabilityCard) {}

  async probe(): Promise<ProbeResult> {
    return {
      available: true,
      observedAt: new Date().toISOString(),
      latencyMs: 0,
      detail: "Hostile mutable fixture is reachable.",
    };
  }

  async *run(_request: MindRequest): AsyncIterable<PublicContribution> {
    this.runCalls += 1;
    yield {
      id: "candidate_hostile_mutation",
      kind: "candidate",
      summary: "This candidate must never cross the local-only boundary.",
    };
  }
}

test("post-admission card and adapter-list mutation cannot change privacy routing or event identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-capability-snapshot-"));
  try {
    const live = mutableCard({
      id: "mind.remote.original",
      displayName: "Remote original",
      network: "provider",
      deterministic: false,
      trust: "quarantined",
    });
    const remote = new MutableRemoteMind(live as unknown as CapabilityCard);
    const local = new RuleMindAdapter();
    const minds: MindAdapter[] = [local, remote];
    const repository = new CaseRepository(root);
    const events = new FileEventHub(root);
    const orchestrator = new JevyrOrchestrator({
      repository,
      events,
      minds,
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
    });

    live.id = "mind.remote.mutated";
    live.displayName = "Mutated identity";
    live.version = "999";
    live.network = "none";
    minds.splice(0, minds.length, remote);

    const created = await orchestrator.cast({
      protocol: "jevyr.case/1",
      case: {
        impulse: "Keep remote minds outside a sealed local-only case",
        privacy: "local_only",
      },
    });
    await orchestrator.waitForTerminal(created.caseId, 10_000);
    const ledger = await events.read(created.caseId);

    assert.equal(remote.runCalls, 0);
    assert.equal(ledger.some((event) => event.actor.id === "mind.remote.original"), true);
    assert.equal(ledger.some((event) => event.actor.id === "mind.remote.mutated"), false);
    assert.equal(ledger.some((event) => event.actor.id === local.capability.id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
