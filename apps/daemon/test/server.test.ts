import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertIntentContractShape,
  canonicalize,
  digestJson,
  validateCaseEventShape,
  type DsseEnvelope,
  type IntentContract,
  type JsonValue,
  type LiveEventBatch,
  type PublicTrustBundle,
  type SealReceipt,
  type SignedRecord,
  type TerminalReceipt,
} from "@jevyr/protocol";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";

test("HTTP daemon rejects nonsensical request-body bounds before runtime construction", () => {
  for (const maxBodyBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => createJevyrHttpService({ maxBodyBytes }),
      /maxBodyBytes must be a positive safe integer/u,
    );
  }
  for (const requestBodyTimeoutMs of [0, -1, 1.5, 300_001]) {
    assert.throws(
      () => createJevyrHttpService({ requestBodyTimeoutMs }),
      /requestBodyTimeoutMs must be a positive safe integer/u,
    );
  }
  for (const clientModelTransportTimeoutMs of [0, -1, 1.5, 86_400_001]) {
    assert.throws(
      () => createJevyrHttpService({ clientModelTransportTimeoutMs }),
      /clientModelTransportTimeoutMs must be a positive safe integer/u,
    );
  }
  assert.throws(
    () => createJevyrHttpService({ requestBodyTimeoutMs: 1_001, clientModelTransportTimeoutMs: 1_000 }),
    /clientModelTransportTimeoutMs cannot be less than requestBodyTimeoutMs/u,
  );
});

async function persistedCaseEntries(root: string): Promise<readonly string[]> {
  try {
    return await readdir(join(root, "cases"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("HTTP daemon exposes exact canonical boundaries, resumable SSE, and no continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-test-"));
  const runtime = createDaemonRuntime({
    dataDir: root,
    minds: [new RuleMindAdapter()],
    forge: new SealedForgeAdapter({ mode: "observe-only" }),
  });
  const service = createJevyrHttpService({ runtime });
  let eventFramePassedBackpressure = false;
  service.server.prependListener("request", (request, response) => {
    if (!request.url?.includes("/events/stream")) return;
    const originalWrite = response.write;
    let imposedBackpressure = false;
    let drained = true;
    response.write = ((chunk: unknown, ...args: unknown[]) => {
      const accepted = Reflect.apply(originalWrite, response, [chunk, ...args]) as boolean;
      const text = typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : "";
      if (!text.startsWith("id: ")) return accepted;
      if (!imposedBackpressure) {
        imposedBackpressure = true;
        drained = false;
        setTimeout(() => {
          drained = true;
          response.emit("drain");
        }, 50);
        return false;
      }
      if (!drained) eventFramePassedBackpressure = true;
      return accepted;
    }) as typeof response.write;
  });
  try {
    const address = await service.listen(0, "127.0.0.1");
    const liveMindCapability = runtime.minds[0]?.capability as unknown as Record<string, unknown>;
    liveMindCapability.id = "mind.http.mutated";
    liveMindCapability.network = "unrestricted";
    const capabilitiesResponse = await fetch(`${address.url}/v1/capabilities`);
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = (await capabilitiesResponse.json()) as {
      adapters: Array<{ capability: { id: string; network: string }; probe: { detail: string; version?: string } }>;
    };
    assert.equal(capabilities.adapters[0]?.capability.id, "mind.rule.v1");
    assert.equal(capabilities.adapters[0]?.capability.network, "none");
    assert.equal(capabilities.adapters[0]?.probe.detail, "Adapter availability probe passed.");
    assert.equal(capabilities.adapters[0]?.probe.version, undefined);
    assert.equal(JSON.stringify(capabilities).includes(root), false);
    liveMindCapability.id = "mind.rule.v1";
    liveMindCapability.network = "none";

    const readinessResponse = await fetch(`${address.url}/v1/readiness`, {
      headers: { origin: "http://localhost:3000" },
    });
    assert.equal(readinessResponse.status, 200);
    assert.equal(readinessResponse.headers.get("cache-control"), "no-store");
    assert.equal(readinessResponse.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const readiness = (await readinessResponse.json()) as {
      protocol: string;
      ready: boolean;
      semanticContinuation: boolean;
      models: { mode: string; reasoningAvailableCount: number };
      forge: { status: string; usable: boolean };
      assays: { status: string; count: number; caseApplicability: string };
      blockers: Array<{ code: string; detail: string }>;
    };
    assert.equal(readiness.protocol, "jevyr.readiness/1");
    assert.equal(readiness.ready, false);
    assert.equal(readiness.semanticContinuation, false);
    assert.equal(readiness.models.mode, "template-only");
    assert.equal(readiness.models.reasoningAvailableCount, 0);
    assert.equal(readiness.forge.status, "observe-only");
    assert.equal(readiness.forge.usable, false);
    assert.equal(readiness.assays.status, "empty");
    assert.equal(readiness.assays.count, 0);
    assert.equal(readiness.assays.caseApplicability, "case-dependent");
    assert.deepEqual(readiness.blockers.map((blocker) => blocker.code), [
      "models.template-only",
      "forge.observe-only",
      "assays.empty",
    ]);
    assert.equal(JSON.stringify(readiness).includes(root), false);

    const castResponse = await fetch(`${address.url}/v1/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "jevyr.case/1",
        case: {
          impulse: "Create and judge a fluid control surface",
          control: "sovereign",
          subjects: [{ id: "brief", kind: "text", locator: "fluid control surface" }],
        },
      }),
    });
    assert.equal(castResponse.status, 202);
    const cast = (await castResponse.json()) as SealReceipt;
    assert.equal(cast.protocol, "jevyr.seal/1");
    assert.match(cast.caseId, /^case_/);
    assert.match(cast.subjectMaterialCaptureDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(cast.caseDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(cast.runDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(castResponse.headers.get("location"), `/v1/cases/${cast.caseId}`);
    assert.match(
      castResponse.headers.get("link") ?? "",
      new RegExp(`</v1/cases/${cast.caseId}/intent-contract>; rel="replay-contract"`),
    );
    assert.match(
      castResponse.headers.get("link") ?? "",
      new RegExp(`</v1/cases/${cast.caseId}/policy-descriptor>; rel="replay-policy"`),
    );

    const intentContractResponse = await fetch(
      `${address.url}/v1/cases/${cast.caseId}/intent-contract`,
    );
    assert.equal(intentContractResponse.status, 200);
    const intentContract = (await intentContractResponse.json()) as IntentContract;
    assert.doesNotThrow(() => assertIntentContractShape(intentContract));
    assert.equal(intentContract.digest, cast.intentContractDigest);
    assert.equal(intentContract.originalImpulse, "Create and judge a fluid control surface");

    const legacyControl = await fetch(`${address.url}/v1/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "jevyr.case/1",
        case: { impulse: "legacy", sovereignty: "sovereign" },
      }),
    });
    assert.equal(legacyControl.status, 400);

    const firstPoll = await fetch(
      `${address.url}/v1/cases/${cast.caseId}/events?after=0&waitMs=1000&limit=2`,
    );
    assert.equal(firstPoll.status, 200);
    const firstPage = (await firstPoll.json()) as LiveEventBatch;
    assert.equal(firstPage.protocol, "jevyr.live/1");
    assert.equal(firstPage.afterSequence, 0);
    assert.ok(firstPage.events.length > 0);
    assert.equal(firstPage.events[0]?.sequence, 1);
    assert.equal(
      firstPage.events.every((event) => validateCaseEventShape(event).ok),
      true,
    );
    assert.equal("nextCursor" in firstPage, false);
    assert.equal("terminal" in firstPage, false);

    const [statusWrite, eventsWrite, streamWrite, steeringQuery, ambiguousCursor] = await Promise.all([
      fetch(`${address.url}/v1/cases/${cast.caseId}`, { method: "POST" }),
      fetch(`${address.url}/v1/cases/${cast.caseId}/events`, { method: "POST" }),
      fetch(`${address.url}/v1/cases/${cast.caseId}/events/stream`, { method: "POST" }),
      fetch(`${address.url}/v1/cases/${cast.caseId}/events?input=change-your-answer`),
      fetch(`${address.url}/v1/cases/${cast.caseId}/events?after=0&cursor=1`),
    ]);
    for (const response of [statusWrite, eventsWrite, streamWrite]) {
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET");
    }
    assert.equal(steeringQuery.status, 400);
    assert.equal(ambiguousCursor.status, 400);

    const terminal = await runtime.orchestrator.waitForTerminal(cast.caseId, 10_000);
    assert.equal(
      terminal.lifecycle,
      "terminated",
      (await runtime.repository.status(cast.caseId))?.error,
    );
    const remainder = await fetch(
      `${address.url}/v1/cases/${cast.caseId}/events?after=${firstPage.throughSequence}`,
    );
    const remainderPage = (await remainder.json()) as LiveEventBatch;
    assert.equal(remainderPage.protocol, "jevyr.live/1");
    assert.equal(remainderPage.caseDigest, cast.caseDigest);
    assert.equal(remainderPage.runDigest, cast.runDigest);
    assert.equal(remainderPage.afterSequence, firstPage.throughSequence);
    assert.equal(
      remainderPage.events.every((event) => event.sequence > firstPage.throughSequence),
      true,
    );
    assert.equal(remainderPage.caughtUp, true);
    assert.equal(remainderPage.events.at(-1)?.eventDigest, remainderPage.headDigest);

    const sseResponse = await fetch(`${address.url}/v1/cases/${cast.caseId}/events/stream?after=0`, {
      headers: { "last-event-id": String(firstPage.throughSequence) },
    });
    assert.equal(sseResponse.status, 200);
    const stream = await sseResponse.text();
    assert.match(stream, /id: \d+\ndata: \{"actor":.*"protocol":"jevyr\.event\/1"/u);
    assert.doesNotMatch(stream, /\nevent:/);
    assert.doesNotMatch(stream, new RegExp(`id: ${firstPage.throughSequence}\\n`));
    const streamedIds = [...stream.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));
    assert.ok(streamedIds.length > 1);
    assert.equal(eventFramePassedBackpressure, false);
    assert.equal(streamedIds[0], firstPage.throughSequence + 1);
    assert.equal(new Set(streamedIds).size, streamedIds.length);
    for (let index = 1; index < streamedIds.length; index += 1) {
      assert.equal(streamedIds[index], streamedIds[index - 1]! + 1);
    }

    const terminalStatusResponse = await fetch(`${address.url}/v1/cases/${cast.caseId}`);
    const terminalStatus = (await terminalStatusResponse.json()) as { lastSequence: number; headDigest: string };
    const terminalTailResponse = await fetch(
      `${address.url}/v1/cases/${cast.caseId}/events?after=${terminalStatus.lastSequence - 1}&limit=1`,
    );
    const terminalTail = (await terminalTailResponse.json()) as LiveEventBatch;
    assert.equal(terminalTail.events[0]?.sequence, terminalStatus.lastSequence);
    assert.equal(terminalTail.events[0]?.eventDigest, terminalStatus.headDigest);
    assert.equal(terminalTail.headDigest, terminalStatus.headDigest);
    const terminalPollResponse = await fetch(
      `${address.url}/v1/cases/${cast.caseId}/events?after=${terminalStatus.lastSequence}&waitMs=30000`,
      { signal: AbortSignal.timeout(1_000) },
    );
    assert.equal(terminalPollResponse.status, 200);
    const terminalPoll = (await terminalPollResponse.json()) as LiveEventBatch;
    assert.equal(terminalPoll.caughtUp, true);
    assert.deepEqual(terminalPoll.events, []);
    assert.equal(terminalPoll.throughSequence, terminalStatus.lastSequence);
    const terminalResume = await fetch(`${address.url}/v1/cases/${cast.caseId}/events/stream?after=0`, {
      headers: { "last-event-id": String(terminalStatus.lastSequence) },
    });
    assert.equal(terminalResume.status, 200);
    assert.equal(await terminalResume.text(), "retry: 1500\n\n");

    const [badEventId, aheadPoll, aheadStream, repeatedCursor, statusQuery] = await Promise.all([
      fetch(`${address.url}/v1/cases/${cast.caseId}/events/stream`, {
        headers: { "last-event-id": "1e0" },
      }),
      fetch(`${address.url}/v1/cases/${cast.caseId}/events?after=${terminalStatus.lastSequence + 1}`),
      fetch(`${address.url}/v1/cases/${cast.caseId}/events/stream?after=${terminalStatus.lastSequence + 1}`),
      fetch(`${address.url}/v1/cases/${cast.caseId}/events?after=0&after=0`),
      fetch(`${address.url}/v1/cases/${cast.caseId}?input=late-steering`),
    ]);
    assert.equal(badEventId.status, 400);
    assert.equal(aheadPoll.status, 409);
    assert.equal(aheadStream.status, 409);
    assert.equal(repeatedCursor.status, 400);
    assert.equal(statusQuery.status, 400);

    const forbidden = await fetch(`${address.url}/v1/cases/${cast.caseId}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "change your answer" }),
    });
    assert.equal(forbidden.status, 405);

    const statusResponse = await fetch(`${address.url}/v1/cases/${cast.caseId}`);
    const status = (await statusResponse.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(status).sort(), [
      "caseDigest",
      "headDigest",
      "lastSequence",
      "lifecycle",
      "protocol",
      "runDigest",
      "stage",
      "stageStatus",
      "updatedAt",
    ]);
    assert.equal(status.lifecycle, "terminated");

    const recordResponse = await fetch(`${address.url}/v1/cases/${cast.caseId}/record`);
    assert.equal(recordResponse.status, 200);
    const record = (await recordResponse.json()) as SignedRecord;
    assert.equal(record.protocol, "jevyr.record/1");
    assert.equal(record.verdict.judgment, "UNPROVEN");
    assert.equal("signature" in record, false);

    const terminalReceiptResponse = await fetch(`${address.url}/v1/cases/${cast.caseId}/terminal`);
    assert.equal(terminalReceiptResponse.status, 200);
    const terminalReceipt = (await terminalReceiptResponse.json()) as TerminalReceipt;
    assert.equal(terminalReceipt.protocol, "jevyr.terminal/1");
    assert.equal(terminalReceipt.caseId, cast.caseId);
    assert.equal(terminalReceipt.caseDigest, record.caseDigest);
    assert.equal(terminalReceipt.runDigest, record.runDigest);
    assert.equal(terminalReceipt.recordDigest, digestJson(record as unknown as JsonValue));
    assert.equal(terminalReceipt.lastSequence, terminalStatus.lastSequence);
    assert.equal(terminalReceipt.eventHeadDigest, terminalStatus.headDigest);
    assert.equal(terminalReceipt.closedAt, terminalTail.events[0]?.observedAt);

    const policyDescriptorResponse = await fetch(
      `${address.url}/v1/cases/${cast.caseId}/policy-descriptor`,
    );
    assert.equal(policyDescriptorResponse.status, 200);
    const policyDescriptor = (await policyDescriptorResponse.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(policyDescriptor).sort(), [
      "artifact",
      "caseDigest",
      "caseId",
      "policyDigest",
      "protocol",
      "runDigest",
    ]);
    assert.equal(policyDescriptor.protocol, "jevyr.case-policy-descriptor/1");
    assert.equal(policyDescriptor.caseId, cast.caseId);
    assert.equal(policyDescriptor.caseDigest, record.caseDigest);
    assert.equal(policyDescriptor.runDigest, record.runDigest);
    assert.equal(policyDescriptor.policyDigest, record.policyDigest);
    const descriptorArtifact = policyDescriptor.artifact as Record<string, unknown>;
    assert.equal(descriptorArtifact.protocol, "jevyr.descriptor-artifact/1");
    assert.equal(descriptorArtifact.kind, "policy");
    assert.equal(descriptorArtifact.digest, record.policyDigest);
    assert.equal(digestJson(descriptorArtifact.descriptor as JsonValue), record.policyDigest);

    const [trustResponse, sealEnvelopeResponse, recordEnvelopeResponse, terminalEnvelopeResponse] = await Promise.all([
      fetch(`${address.url}/v1/trust`),
      fetch(`${address.url}/v1/cases/${cast.caseId}/seal/envelope`),
      fetch(`${address.url}/v1/cases/${cast.caseId}/record/envelope`),
      fetch(`${address.url}/v1/cases/${cast.caseId}/terminal/envelope`),
    ]);
    assert.equal(trustResponse.status, 200);
    assert.equal(sealEnvelopeResponse.status, 200);
    assert.equal(recordEnvelopeResponse.status, 200);
    assert.equal(terminalEnvelopeResponse.status, 200);
    const trust = (await trustResponse.json()) as PublicTrustBundle;
    const sealEnvelope = (await sealEnvelopeResponse.json()) as DsseEnvelope;
    const recordEnvelope = (await recordEnvelopeResponse.json()) as DsseEnvelope;
    const terminalEnvelope = (await terminalEnvelopeResponse.json()) as DsseEnvelope;
    assert.equal(trust.protocol, "jevyr.trust-bundle/1");
    assert.equal(trust.keys.length, 1);
    assert.deepEqual(Object.keys(trust.keys[0]!).sort(), [
      "algorithm",
      "keyId",
      "payloadTypes",
      "publicKeyPem",
    ]);
    assert.equal(trust.keys[0]!.algorithm, "Ed25519");
    assert.deepEqual(trust.keys[0]!.payloadTypes, [
      "application/vnd.jevyr.seal+json",
      "application/vnd.jevyr.record+json",
      "application/vnd.jevyr.terminal+json",
    ]);
    assert.equal(JSON.stringify(trust).includes("PRIVATE KEY"), false);
    assert.equal(JSON.stringify(trust).toLowerCase().includes("privatepath"), false);
    const publicKey = createPublicKey(trust.keys[0]!.publicKeyPem);
    for (const [envelope, payload] of [
      [sealEnvelope, cast],
      [recordEnvelope, record],
      [terminalEnvelope, terminalReceipt],
    ] as const) {
      assert.equal(envelope.signatures[0]?.keyid, trust.keys[0]!.keyId);
      const body = Buffer.from(envelope.payload, "base64");
      const type = Buffer.from(envelope.payloadType);
      const pae = Buffer.concat([
        Buffer.from(`DSSEv1 ${type.length} `),
        type,
        Buffer.from(` ${body.length} `),
        body,
      ]);
      assert.equal(
        verify(null, pae, publicKey, Buffer.from(envelope.signatures[0]!.sig, "base64")),
        true,
      );
      assert.equal(body.toString("utf8"), canonicalize(payload as unknown as JsonValue));
    }

    const cors = await fetch(`${address.url}/health`, {
      headers: { origin: "http://localhost:3000" },
    });
    assert.equal(cors.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(
      cors.headers.get("access-control-expose-headers"),
      "x-jevyr-digest,content-length,content-type,content-disposition",
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cast refuses malformed UTF-8 instead of normalizing hostile bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-utf8-test-"));
  const runtime = createDaemonRuntime({
    dataDir: root,
    minds: [new RuleMindAdapter()],
    forge: new SealedForgeAdapter({ mode: "observe-only" }),
  });
  const service = createJevyrHttpService({ runtime });
  try {
    const address = await service.listen(0, "127.0.0.1");
    const response = await fetch(`${address.url}/v1/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      protocol: "jevyr.error/1",
      status: 400,
      error: "Request body is not valid UTF-8",
    });
    assert.deepEqual(await persistedCaseEntries(root), []);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cast refuses duplicate JSON control keys before creating a Case", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-duplicate-json-test-"));
  const runtime = createDaemonRuntime({
    dataDir: root,
    minds: [new RuleMindAdapter()],
    forge: new SealedForgeAdapter({ mode: "observe-only" }),
  });
  const service = createJevyrHttpService({ runtime });
  try {
    const address = await service.listen(0, "127.0.0.1");
    const response = await fetch(`${address.url}/v1/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"protocol":"jevyr.case/1","case":{"impulse":"first authority","impulse":"second authority"}}',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      protocol: "jevyr.error/1",
      status: 400,
      error: "Request body is not valid JSON",
    });
    assert.deepEqual(await persistedCaseEntries(root), []);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy Forge plan cannot invent a candidate or manufacture proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-forge-test-"));
  const planPath = join(root, "forge-plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('artifact.txt','executed evidence')"],
      timeoutMs: 10_000,
    }),
    "utf8",
  );
  const runtime = createDaemonRuntime({
    dataDir: join(root, "data"),
    env: {
      JEVYR_FORGE_PLAN_FILE: planPath,
    },
    forgeConfig: { mode: "trusted-host", allowTrustedHost: true },
    minds: [new RuleMindAdapter()],
  });
  try {
    const created = await runtime.orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "Produce a concrete artifact and test it" },
    });
    await runtime.orchestrator.waitForTerminal(created.caseId, 10_000);
    const record = await runtime.repository.record(created.caseId);
    assert.equal(record?.verdict.creation, "NO_SURVIVOR");
    assert.equal(record?.verdict.embodiment, "NOT_BUILT");
    assert.equal(record?.verdict.judgment, "UNPROVEN");
    assert.equal(
      record?.verdict.basis.some((entry) => entry.code === "UNASSAYABLE_OBLIGATION"),
      true,
    );
    const artifacts = await runtime.repository.artifacts(created.caseId);
    assert.equal(
      artifacts.some((artifact) => artifact.name === "artifact.txt"),
      false,
    );
    assert.equal(
      artifacts.every((artifact) => /^sha256:[a-f0-9]{64}$/.test(artifact.digest)),
      true,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
