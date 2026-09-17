import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileIntentContract,
  compileVerdict,
  evaluateReflex,
  MemoryLedger,
  projectEvents,
  replayCase,
  generateSigningKeyPair,
  sealCase,
  sealReceipt,
  signSealReceipt,
} from "@jevyr/core";
import { createSearchEnvelope, digestJson } from "@jevyr/protocol";
import {
  compileAssayFrontier,
  DEFAULT_SEARCH_PROFILE,
  encodeToolObservation,
  stableId,
  type ToolObservation,
} from "@jevyr/runtime";
import {
  canonicalJson,
  JevyrClient,
  sha256Digest,
  type IntentContract,
  type JevyrRecord,
  type PublicTraceEvent,
} from "@jevyr/sdk";
import {
  assayFrontierFromPolicyDescriptor,
  compareRecords,
  readIntentContract,
  readRecord,
  readUnsignedDiagnosticRecord,
  replayTrace,
  replayAuthenticatedCase,
} from "../src/replay.js";

const caseDigest = `sha256:${"a".repeat(64)}`;
const runDigest = `sha256:${"b".repeat(64)}`;

async function event(): Promise<PublicTraceEvent> {
  const unsigned = {
    protocol: "jevyr.event/1" as const,
    sequence: 1,
    priorDigest: null,
    caseDigest,
    runDigest,
    observedAt: "2026-09-04T00:00:00.000Z",
    stage: "cast" as const,
    kind: "stage.status" as const,
    actor: { id: "bone", kind: "kernel" as const },
    payload: { stage: "cast" as const, status: "completed" as const, summary: "Cast received." },
  };
  return { ...unsigned, eventDigest: await sha256Digest(canonicalJson(unsigned)) };
}

async function record(judgment: JevyrRecord["verdict"]["judgment"]): Promise<JevyrRecord> {
  const ledgerEvent = await event();
  return {
    protocol: "jevyr.record/1",
    caseDigest,
    runDigest,
    policyDigest: `sha256:${"d".repeat(64)}`,
    genomeDigest: `sha256:${"e".repeat(64)}`,
    searchDigest: `sha256:${"f".repeat(64)}`,
    intentContractDigest: `sha256:${"a".repeat(64)}`,
    eventHeadDigest: ledgerEvent.eventDigest,
    verdict: {
      policyVersion: "bone-v1",
      intentContractDigest: `sha256:${"a".repeat(64)}`,
      evidenceDigest: `sha256:${"c".repeat(64)}`,
      integrity: "VALID",
      creation: "CONCEIVED",
      embodiment: "NOT_BUILT",
      judgment,
      feasibilityByCandidate: {},
      basis: [],
    },
    reflex: {
      loop: 1,
      reviewedEvidenceDigest: `sha256:${"d".repeat(64)}`,
      intentContractDigest: `sha256:${"a".repeat(64)}`,
      challengedNodeIds: [],
      materialFindings: [],
      decision: "confirm",
    },
    memoryInfluences: [],
    crystallizedAt: "2026-09-04T00:00:01.000Z",
  };
}

async function crystallizableTrace(): Promise<{
  record: JevyrRecord;
  events: readonly PublicTraceEvent[];
  intentContract: IntentContract;
}> {
  const intentContract = compileIntentContract({
    impulse: "Create a deterministic replay specimen.",
  });
  const ledger = new MemoryLedger(caseDigest, runDigest);
  await ledger.append({
    protocol: "jevyr.event/1",
    caseDigest,
    runDigest,
    observedAt: "2026-09-04T00:00:00.000Z",
    stage: "recombine",
    kind: "candidate.status",
    actor: { id: "bone", kind: "kernel" },
    payload: {
      candidateId: "candidate:one",
      status: "selected",
      summary: "A deterministic replay specimen.",
      feasibility: "BUILDABLE_NOW",
    },
  });
  const projection = projectEvents(await ledger.read(), { intentContract });
  const provisional = compileVerdict(projection.input);
  const reflex = evaluateReflex(provisional, projection.input, {
    loop: 1,
    canAcquireMaterialEvidence: false,
  });
  await ledger.append({
    protocol: "jevyr.event/1",
    caseDigest,
    runDigest,
    observedAt: "2026-09-04T00:00:01.000Z",
    stage: "reflex",
    kind: "reflex.completed",
    actor: { id: "bone", kind: "kernel" },
    payload: reflex,
  });
  const events = await ledger.read();
  const replay = replayCase(events, { intentContract });
  return {
    events,
    record: {
      protocol: "jevyr.record/1",
      caseDigest,
      runDigest,
      policyDigest: `sha256:${"d".repeat(64)}`,
      genomeDigest: `sha256:${"e".repeat(64)}`,
      searchDigest: `sha256:${"f".repeat(64)}`,
      intentContractDigest: intentContract.digest,
      eventHeadDigest: replay.eventHeadDigest,
      verdict: replay.verdict,
      reflex: replay.reflex,
      memoryInfluences: replay.memoryInfluences,
      crystallizedAt: "2026-09-04T00:00:02.000Z",
    },
    intentContract,
  };
}

async function assayTrace() {
  const intentContract = compileIntentContract({ impulse: "`fixture --check` exits with code 0" });
  const obligation = intentContract.criticalObligations[0];
  if (!obligation) throw new Error("fixture obligation missing");
  const frontier = compileAssayFrontier([{
    assayId: "assay.cli-replay",
    costUnits: 1,
    tool: "forge.command",
    args: { command: "fixture", args: ["--check"] },
    obligationId: obligation.id,
  }], DEFAULT_SEARCH_PROFILE.resources);
  const plan = frontier.assays[0];
  if (!plan) throw new Error("fixture plan missing");
  const observation: ToolObservation = {
    invocationId: stableId("invocation", {
      runDigest,
      candidateId: "candidate:assayed",
      assayId: plan.assayId,
    }),
    status: "succeeded",
    summary: "Persisted CLI replay evidence.",
    startedAt: "2026-09-04T00:00:00.000Z",
    finishedAt: "2026-09-04T00:00:00.010Z",
    exitCode: 0,
    oracle: {
      execution: {
        state: "exited",
        mode: "docker",
        command: "fixture",
        args: ["--check"],
        shell: false,
        exitCode: 0,
        stdout: "",
        stderr: "",
        outputTruncated: false,
      },
    },
    metadata: {
      admissible: true,
      assayFrontierDigest: frontier.digest,
      candidateId: "candidate:assayed",
      assayId: plan.assayId,
      candidateBlueprintDigest: `sha256:${"4".repeat(64)}`,
      candidateMaterializationDigest: `sha256:${"5".repeat(64)}`,
      subjectMaterializationDigest: `sha256:${"6".repeat(64)}`,
      planDigest: await sha256Digest(canonicalJson(plan)),
      planBoundAtSeal: true,
      typedOracleStatus: "PASSED",
      aggregateAdmissible: true,
    },
  };
  const encoded = encodeToolObservation(observation);
  const ledger = new MemoryLedger(caseDigest, runDigest);
  await ledger.append({
    protocol: "jevyr.event/1",
    caseDigest,
    runDigest,
    observedAt: "2026-09-04T00:00:00.000Z",
    stage: "recombine",
    kind: "candidate.status",
    actor: { id: "bone", kind: "kernel" },
    payload: {
      candidateId: "candidate:assayed",
      status: "selected",
      summary: "Selected only after measured archive admission.",
      feasibility: "BUILDABLE_NOW",
    },
  });
  await ledger.append({
    protocol: "jevyr.event/1",
    caseDigest,
    runDigest,
    observedAt: "2026-09-04T00:00:01.000Z",
    stage: "assay",
    kind: "evidence.observed",
    actor: { id: "tool.forge.test.v1", kind: "forge" },
    payload: {
      evidenceId: "evidence_cli_replay",
      evidenceType: "sandbox_execution",
      summary: "Exact persisted evidence.",
      contentDigest: encoded.digest,
      candidateId: "candidate:assayed",
      assayId: plan.assayId,
      supports: [obligation.id],
    },
  });
  const projection = projectEvents(await ledger.read(), { intentContract });
  const provisional = compileVerdict(projection.input);
  const reflex = evaluateReflex(provisional, projection.input, {
    loop: 1,
    canAcquireMaterialEvidence: false,
  });
  await ledger.append({
    protocol: "jevyr.event/1",
    caseDigest,
    runDigest,
    observedAt: "2026-09-04T00:00:02.000Z",
    stage: "reflex",
    kind: "reflex.completed",
    actor: { id: "bone", kind: "kernel" },
    payload: reflex,
  });
  const events = await ledger.read();
  const replay = replayCase(events, { intentContract });
  const descriptor = {
    protocol: "jevyr.policy-descriptor/1" as const,
    version: "jevyr.bone/1",
    policy: {
      protocol: "jevyr.effective-policy/1",
      assayFrontierDigest: frontier.digest,
      assayFrontier: frontier,
    },
    subjectSnapshots: {},
  };
  const policyDigest = await sha256Digest(canonicalJson(descriptor));
  const policyDescriptor = {
    protocol: "jevyr.case-policy-descriptor/1" as const,
    caseId: "case_0123456789abcdef",
    caseDigest,
    runDigest,
    policyDigest,
    artifact: {
      protocol: "jevyr.descriptor-artifact/1" as const,
      kind: "policy" as const,
      digest: policyDigest,
      descriptor,
    },
  };
  const record: JevyrRecord = {
    protocol: "jevyr.record/1",
    caseDigest,
    runDigest,
    policyDigest,
    genomeDigest: `sha256:${"e".repeat(64)}`,
    searchDigest: `sha256:${"f".repeat(64)}`,
    intentContractDigest: intentContract.digest,
    eventHeadDigest: replay.eventHeadDigest,
    verdict: replay.verdict,
    reflex: replay.reflex,
    memoryInfluences: replay.memoryInfluences,
    crystallizedAt: "2026-09-04T00:00:03.000Z",
  };
  return { intentContract, frontier, encoded, events, record, policyDescriptor };
}

describe("replay", () => {
  it("rejects ambiguous or malformed local replay bytes before payload validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-cli-replay-json-"));
    try {
      const recordPath = join(root, "record.json");
      await writeFile(recordPath, '{"protocol":"jevyr.record/0","protocol":"jevyr.record/1"}', "utf8");
      await expect(readRecord(recordPath)).rejects.toThrow(/duplicate object key "protocol"/u);

      const contractPath = join(root, "intent-contract.json");
      const malformed = Buffer.from('{"protocol":"hostile-byte"}', "utf8");
      const marker = malformed.indexOf("hostile-byte");
      expect(marker).toBeGreaterThanOrEqual(0);
      malformed[marker] = 0xff;
      await writeFile(contractPath, malformed);
      await expect(readIntentContract(contractPath)).rejects.toThrow(/not valid UTF-8/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a bare local Record unless unsigned diagnostic mode is explicit", async () => {
    await expect(readUnsignedDiagnosticRecord("record.json", false)).rejects.toThrow(
      "--unsigned-diagnostic",
    );
  });

  it("verifies and deterministically replays the crystallization prefix", async () => {
    const trace = await crystallizableTrace();
    await expect(
      replayTrace(trace.record, trace.events, trace.intentContract),
    ).resolves.toMatchObject({ valid: true, events: 2 });
  });

  it("rejects a record whose prefix omits the mandatory Reflex", async () => {
    const intentContract = compileIntentContract({ impulse: "Inspect this specimen." });
    const unbound = await record("UNPROVEN");
    const bound = {
      ...unbound,
      intentContractDigest: intentContract.digest,
      verdict: { ...unbound.verdict, intentContractDigest: intentContract.digest },
      reflex: { ...unbound.reflex, intentContractDigest: intentContract.digest },
    };
    await expect(replayTrace(bound, [await event()], intentContract)).rejects.toThrow(
      "mandatory Reflex",
    );
  });

  it("cannot replay against a different valid IntentContract", async () => {
    const trace = await crystallizableTrace();
    const other = compileIntentContract({
      impulse: "Create a different deterministic replay specimen.",
    });
    await expect(replayTrace(trace.record, trace.events, other)).resolves.toMatchObject({
      valid: false,
      problems: expect.arrayContaining(["IntentContract digest does not match the Record"]),
    });
  });

  it("refuses sandbox authority without a complete independently replayable transcript", async () => {
    const trace = await assayTrace();
    await expect(replayTrace(trace.record, trace.events, trace.intentContract)).resolves.toMatchObject({
      valid: false,
      problems: expect.arrayContaining([
        expect.stringContaining("no exact policy descriptor and artifact resolver were supplied"),
      ]),
    });
    const verified = await replayTrace(trace.record, trace.events, trace.intentContract, {
      persistedEvidence: {
        policyDescriptor: trace.policyDescriptor,
        resolveArtifact: async (digest) => digest === trace.encoded.digest ? trace.encoded.bytes : undefined,
      },
    });
    expect(verified.valid, JSON.stringify(verified.problems)).toBe(false);
    expect(verified.evidenceReplay).toMatchObject({
      replayComplete: false,
      sandboxExecutionCount: 1,
      verifiedAuthorityEdges: [],
    });
    expect(verified.problems).toEqual(expect.arrayContaining([
      expect.stringContaining("MATRIX_INCOMPLETE"),
    ]));

    const substitutedPolicy = {
      ...trace.policyDescriptor,
      artifact: {
        ...trace.policyDescriptor.artifact,
        descriptor: {
          ...trace.policyDescriptor.artifact.descriptor,
          version: "substituted-after-signing",
        },
      },
    };
    await expect(replayTrace(trace.record, trace.events, trace.intentContract, {
      persistedEvidence: {
        policyDescriptor: substitutedPolicy,
        resolveArtifact: async () => trace.encoded.bytes,
      },
    })).resolves.toMatchObject({
      valid: false,
      problems: expect.arrayContaining([
        expect.stringContaining("Descriptor artifact bytes do not match its SHA-256 digest"),
      ]),
    });
  });

  it("extracts only the Assay Frontier committed inside the authenticated policy descriptor", async () => {
    const trace = await assayTrace();
    const binding = trace.policyDescriptor;
    expect(assayFrontierFromPolicyDescriptor(binding)).toEqual(trace.frontier);
    expect(() => assayFrontierFromPolicyDescriptor({
      ...binding,
      artifact: {
        ...binding.artifact,
        descriptor: {
          ...binding.artifact.descriptor,
          policy: {
            ...(binding.artifact.descriptor.policy as Record<string, unknown>),
            assayFrontierDigest: `sha256:${"9".repeat(64)}`,
          },
        },
      },
    })).toThrow("does not bind one exact Assay Frontier");
  });

  it("requires persisted replay for original-subject actions even without a sandbox event", async () => {
    const trace = await crystallizableTrace(), ledger = new MemoryLedger(caseDigest, runDigest);
    await ledger.append({ protocol: "jevyr.event/1", caseDigest, runDigest, observedAt: "2026-09-04T00:00:00.000Z",
      stage: "self_scan", kind: "action.status", actor: { id: "jevyr.bone", kind: "kernel" },
      payload: { actionId: "original-fixture", actionType: "repository-pure.evaluate", status: "denied", summary: "The fixture has no original source certificate." } });
    for (const { sequence: _sequence, priorDigest: _priorDigest, eventDigest: _eventDigest, ...draft } of trace.events) await ledger.append(draft);
    const events = await ledger.read(), record = { ...trace.record, eventHeadDigest: events.at(-1)!.eventDigest };
    const replay = await replayTrace(record, events, trace.intentContract);
    expect(replay.valid).toBe(false);
    expect(replay.problems).toContainEqual(expect.stringContaining("no exact policy descriptor and artifact resolver were supplied"));
  });

  it("cannot treat a digest-addressed original certificate or public verified flag as authenticated source authority", async () => {
    const trace = await assayTrace(), ledger = new MemoryLedger(caseDigest, runDigest);
    const forged = Buffer.from(JSON.stringify({ protocol: "jevyr.original-subject-assertion-certificate/1", verified: true, supports: [trace.intentContract.criticalObligations[0]!.id] }));
    const forgedDigest = await sha256Digest(forged.toString("utf8"));
    for (const status of ["started", "completed"] as const) {
      await ledger.append({ protocol: "jevyr.event/1", caseDigest, runDigest, observedAt: "2026-09-04T00:00:00.000Z",
        stage: "self_scan", kind: "action.status", actor: { id: "jevyr.bone", kind: "kernel" },
        payload: { actionId: "original-fixture", actionType: "repository-pure.evaluate", status, summary: "Untrusted certificate fixture.",
          ...(status === "completed" ? { artifactDigests: [forgedDigest] } : {}) } });
    }
    for (const { sequence: _sequence, priorDigest: _priorDigest, eventDigest: _eventDigest, ...draft } of trace.events) await ledger.append(draft);
    const events = await ledger.read(), record = { ...trace.record, eventHeadDigest: events.at(-1)!.eventDigest };
    for (const supplied of [undefined, { verified: true }]) {
      const replay = await replayTrace(record, events, trace.intentContract, { persistedEvidence: {
        policyDescriptor: trace.policyDescriptor,
        resolveArtifact: async digest => digest === forgedDigest ? forged : digest === trace.encoded.digest ? trace.encoded.bytes : undefined,
        ...(supplied === undefined ? {} : { originalSubject: supplied as never }),
      } });
      expect(replay.valid).toBe(false);
      expect(replay.evidenceReplay?.verifiedOriginalSubjectEdges).toEqual([]);
      expect(replay.evidenceReplay?.originalSubjectContext).toBeUndefined();
      expect(replay.evidenceReplay?.problems).toContainEqual(expect.objectContaining({ code: "ORIGINAL_SUBJECT_CERTIFICATE_INVALID" }));
    }
  });

  it("remote original-subject replay authenticates the full Case before fetching any certificate", async () => {
    const trace = await assayTrace(), keys = generateSigningKeyPair(), foreignKeys = generateSigningKeyPair();
    const makeCase = (locator: string) => sealCase({ protocol: "jevyr.case/1", case: { impulse: "Existing tests must pass.", seed: "12".repeat(32),
      subjects: [{ id: "source", kind: "directory", locator }] } }, {
      policyVersion: "bone-v1", policyDigest: trace.record.policyDigest, genomeVersion: "fixture-genome", genomeDigest: trace.record.genomeDigest,
      searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), sealedAt: "2026-09-04T00:00:00.000Z",
      subjectMaterialCaptureDigest: digestJson({ fixture: "no source authority" }),
      subjectSnapshots: [{ subjectId: "source", resolvedLocator: locator, digest: digestJson({ fixture: "source" }), byteLength: 1, capturedAt: "2026-09-04T00:00:00.000Z" }],
    });
    const original = makeCase("/sealed/original"), receipt = sealReceipt(original), envelope = signSealReceipt(receipt, keys.privateKeyPem);
    const trust = { protocol: "jevyr.trust-bundle/1", keys: [{ keyId: keys.keyId, algorithm: "Ed25519", publicKeyPem: keys.publicKeyPem,
      payloadTypes: ["application/vnd.jevyr.seal+json", "application/vnd.jevyr.record+json", "application/vnd.jevyr.terminal+json"] }] };
    const ledger = new MemoryLedger(original.caseDigest, original.runDigest);
    await ledger.append({ protocol: "jevyr.event/1", caseDigest: original.caseDigest, runDigest: original.runDigest, observedAt: original.sealedAt,
      stage: "self_scan", kind: "action.status", actor: { id: "jevyr.bone", kind: "kernel" },
      payload: { actionId: "original-fixture", actionType: "repository-pure.evaluate", status: "denied", summary: "Fixture action; no certificate authority." } });
    const events = await ledger.read();
    for (const failure of ["missing", "rehashed-locator", "foreign-signing-key"] as const) {
      const fetcher = vi.fn<typeof fetch>(async input => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/trust") return Response.json(trust);
        if (path.endsWith("/sealed-case")) return failure === "missing" ? Response.json({ error: "missing" }, { status: 404 })
          : Response.json(failure === "rehashed-locator" ? makeCase("/changed/original") : original);
        if (path.endsWith("/seal/envelope")) return Response.json(failure === "foreign-signing-key" ? signSealReceipt(receipt, foreignKeys.privateKeyPem) : envelope);
        if (path.endsWith("/seal")) return Response.json(receipt);
        throw new Error(`Unexpected transport request: ${path}`);
      });
      const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
      vi.spyOn(client, "verifiedPolicyDescriptor").mockResolvedValue({ binding: trace.policyDescriptor } as never);
      vi.spyOn(client, "verifiedIntentContract").mockResolvedValue(trace.intentContract);
      vi.spyOn(client, "pollEvents").mockResolvedValue({ events, throughSequence: 1, caughtUp: true } as never);
      await expect(replayAuthenticatedCase(client, original.caseId, trace.record)).rejects.toThrow();
      expect(fetcher.mock.calls.some(([input]) => String(input).includes("/artifacts"))).toBe(false);
    }
  });

  it("compares independent outcome axes", async () =>
    expect(compareRecords(await record("UNPROVEN"), await record("REJECT"))).toContainEqual({
      field: "verdict.judgment",
      left: "UNPROVEN",
      right: "REJECT",
    }));

  it("remote v2 always requires an authenticated full Seal even with no original-subject activity", async () => {
    const trace = await crystallizableTrace(), binding = (await assayTrace()).policyDescriptor;
    for (const versionSource of ["record", "authenticated-policy"] as const) {
      const client = new JevyrClient({ baseUrl: "http://test", fetch: vi.fn() });
      vi.spyOn(client, "verifiedPolicyDescriptor").mockResolvedValue({ binding: versionSource === "authenticated-policy"
        ? { ...binding, artifact: { ...binding.artifact, descriptor: { ...binding.artifact.descriptor, version: "jevyr.bone/2" } } } : binding } as never);
      vi.spyOn(client, "verifiedIntentContract").mockResolvedValue(trace.intentContract);
      vi.spyOn(client, "pollEvents").mockResolvedValue({ events: trace.events, throughSequence: trace.events.length, caughtUp: true } as never);
      vi.spyOn(client, "trustBundle").mockResolvedValue({ protocol: "jevyr.trust-bundle/1", keys: [] });
      const fullSeal = vi.spyOn(client, "verifiedSealedCase").mockRejectedValue(new Error("missing authenticated full sealed Case"));
      vi.spyOn(client, "sealEnvelope").mockResolvedValue({} as never);
      const artifacts = vi.spyOn(client, "listArtifacts");
      const record = versionSource === "record" ? { ...trace.record, verdict: { ...trace.record.verdict, policyVersion: "jevyr.bone/2" } } : trace.record;
      await expect(replayAuthenticatedCase(client, binding.caseId, record)).rejects.toThrow("missing authenticated full sealed Case");
      expect(fullSeal).toHaveBeenCalledExactlyOnceWith(binding.caseId);
      expect(artifacts).not.toHaveBeenCalled();
    }
  });
});
