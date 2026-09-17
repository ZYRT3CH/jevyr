import assert from "node:assert/strict";
import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CaseRepository, RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";

function runtimeAt(dataDir: string) {
  return createDaemonRuntime({
    dataDir,
    minds: [new RuleMindAdapter()],
    forge: new SealedForgeAdapter({ mode: "observe-only" }),
  });
}

test("startup invalidates an interrupted case instead of rerunning it", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-invalid-"));
  let second: ReturnType<typeof runtimeAt> | undefined;
  try {
    const interrupted = await new CaseRepository(root).create({
      protocol: "jevyr.case/1",
      case: { impulse: "This case must never be silently resumed after a process restart" },
    });

    second = runtimeAt(root);
    await second.ready();
    assert.equal(Object.isFrozen(second.memory), true);
    assert.equal("appendEvidenceObservation" in second.memory, false);
    assert.equal("reconcileEvidenceBatch" in second.memory, false);
    assert.equal("stage" in second.memory, false);
    const status = await second.repository.status(interrupted.caseId);
    assert.equal(status?.lifecycle, "invalid");
    assert.equal(status?.stageStatus, "failed");
    assert.match(status?.error ?? "", /Runtime restart interrupted a nonterminal case/);

    const events = await second.events.read(interrupted.caseId);
    const recovery = events.find((event) =>
      event.kind === "action.status" && event.payload.actionType === "runtime.recovery.invalidate-interrupted-run",
    );
    assert.ok(recovery);
    assert.equal(recovery.payload.status, "failed");
    assert.equal(status?.lastSequence, events.at(-1)?.sequence);
    assert.equal(status?.headDigest, events.at(-1)?.eventDigest);

    const record = await second.repository.record(interrupted.caseId);
    const envelope = await second.repository.recordEnvelope(interrupted.caseId);
    assert.ok(record);
    assert.ok(envelope);
    assert.equal(record.eventHeadDigest, events.at(-1)?.eventDigest);
    assert.equal(record.intentContractDigest, interrupted.sealed.intentContractDigest);
    assert.equal(record.policyDigest, interrupted.sealed.policyDigest);
    assert.equal(record.genomeDigest, interrupted.sealed.genomeDigest);
    assert.equal(record.searchDigest, interrupted.sealed.searchEnvelope.digest);
    assert.equal(record.verdict.integrity, "INVALID");
    assert.equal(record.verdict.judgment, "NOT_APPLICABLE");
    assert.equal(record.verdict.basis.some((entry) => entry.code === "RUNTIME_RESTART_INTERRUPTED_CASE"), true);
  } finally {
    await second?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup refuses malformed or duplicate status authority before recovery can append or sign", async (context) => {
  for (const corruption of ["duplicate-lifecycle", "malformed-utf8"] as const) {
    await context.test(corruption, async () => {
      const root = await mkdtemp(join(tmpdir(), `jevyr-recovery-status-${corruption}-`));
      try {
        const repository = new CaseRepository(root);
        const created = await repository.create({
          protocol: "jevyr.case/1",
          case: { impulse: "Corrupt status must never acquire recovery authority." },
        });
        const statusPath = join(root, "cases", created.caseId, "status.json");
        const original = await readFile(statusPath, "utf8");
        if (corruption === "duplicate-lifecycle") {
          const altered = original.replace(
            '  "lifecycle": "queued",',
            '  "lifecycle": "terminated",\n  "lifecycle": "queued",',
          );
          assert.notEqual(altered, original);
          await writeFile(statusPath, altered, "utf8");
        } else {
          const value = JSON.parse(original) as Record<string, unknown>;
          value.error = "hostile-byte";
          const altered = Buffer.from(JSON.stringify(value), "utf8");
          const marker = altered.indexOf("hostile-byte");
          assert.ok(marker >= 0);
          altered[marker] = 0xff;
          await writeFile(statusPath, altered);
        }

        await assert.rejects(
          repository.nonterminalStatuses(),
          corruption === "duplicate-lifecycle" ? /duplicate object key "lifecycle"/u : /not valid UTF-8/u,
        );
        await assert.rejects(
          readFile(join(root, "cases", created.caseId, "recovery-record.json")),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a partial Record pair is preserved while recovery publishes the emergency Record", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-partial-record-"));
  let second: ReturnType<typeof runtimeAt> | undefined;
  try {
    const interrupted = await new CaseRepository(root).create({
      protocol: "jevyr.case/1",
      case: { impulse: "Preserve forensic Record fragments across recovery" },
    });
    const orphan = Buffer.from("{\"partial\":true}\n");
    await writeFile(join(root, "cases", interrupted.caseId, "record.json"), orphan);

    second = runtimeAt(root);
    await second.ready();
    assert.deepEqual(await readFile(join(root, "cases", interrupted.caseId, "record.json")), orphan);
    assert.ok((await readFile(join(root, "cases", interrupted.caseId, "recovery-record.json"))).byteLength > 0);
    assert.ok((await readFile(join(root, "cases", interrupted.caseId, "recovery-record.dsse.json"))).byteLength > 0);
    const record = await second.repository.record(interrupted.caseId);
    assert.equal(record?.verdict.integrity, "INVALID");
    assert.equal(record?.verdict.judgment, "NOT_APPLICABLE");
  } finally {
    await second?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup completes an INVALID transition interrupted before its recovery signature", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-invalid-gap-"));
  let second: ReturnType<typeof runtimeAt> | undefined;
  try {
    const fixture = new CaseRepository(root);
    const interrupted = await fixture.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Retry the fixed recovery commit after the invalid-state crash gap" },
    });
    const originalError = "The prior daemon durably invalidated this Case before its recovery signature reached disk.";
    await fixture.updateStatus(interrupted.caseId, {
      lifecycle: "invalid",
      stage: "self_scan",
      stageStatus: "failed",
      lastSequence: 0,
      headDigest: null,
      error: originalError,
    });

    second = runtimeAt(root);
    await second.ready();
    const status = await second.repository.status(interrupted.caseId);
    const record = await second.repository.record(interrupted.caseId);
    assert.equal(status?.lifecycle, "invalid");
    assert.equal(status?.error, originalError);
    assert.equal(record?.verdict.integrity, "INVALID");
    assert.deepEqual(record?.verdict.basis, [{
      code: "RUNTIME_RESTART_INTERRUPTED_CASE",
      summary: originalError,
      evidenceIds: [],
    }]);
  } finally {
    await second?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup terminates around an existing signed Record without rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-signed-"));
  const first = runtimeAt(root);
  let second: ReturnType<typeof runtimeAt> | undefined;
  let third: ReturnType<typeof runtimeAt> | undefined;
  let fourth: ReturnType<typeof runtimeAt> | undefined;
  try {
    await first.ready();
    const created = await first.orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "Crystallize a signed record for restart recovery" },
    });
    const terminal = await first.orchestrator.waitForTerminal(created.caseId, 10_000);
    const beforeEvents = await first.events.read(created.caseId);
    const memoryCommitment = beforeEvents.find((event) =>
      event.kind === "action.status"
      && event.stage === "crystallize"
      && event.payload.actionType === "memory.candidate.commitment",
    );
    const committedMemoryDigest = memoryCommitment?.kind === "action.status"
      ? memoryCommitment.payload.artifactDigests?.[0]
      : undefined;
    assert.ok(committedMemoryDigest);
    const beforeRecord = await readFile(join(root, "cases", created.caseId, "record.json"));
    const beforeEnvelope = await readFile(join(root, "cases", created.caseId, "record.dsse.json"));
    await first.close();
    await Promise.all([
      rm(join(root, "cases", created.caseId, "terminal.json")),
      rm(join(root, "cases", created.caseId, "terminal.dsse.json")),
    ]);
    await new CaseRepository(root).updateStatus(created.caseId, {
      lifecycle: "crystallized",
      stage: "sign",
      stageStatus: "completed",
      lastSequence: terminal.lastSequence,
      headDigest: terminal.headDigest,
    });

    // Model a crash after the signed commitment reached disk but before the
    // idempotent MEMORY_TRIBUNAL SQLite side effect became durable.
    const memoryDb = new DatabaseSync(join(root, "memory", "temporal-deep.sqlite"));
    memoryDb.prepare("DELETE FROM memories WHERE digest = ?").run(committedMemoryDigest);
    memoryDb.close();

    second = runtimeAt(root);
    await second.ready();
    const recovered = await second.repository.status(created.caseId);
    assert.equal(recovered?.lifecycle, "terminated");
    assert.equal(recovered?.stage, "terminate");
    assert.equal(recovered?.stageStatus, "completed");
    assert.deepEqual(await readFile(join(root, "cases", created.caseId, "record.json")), beforeRecord);
    assert.deepEqual(await readFile(join(root, "cases", created.caseId, "record.dsse.json")), beforeEnvelope);
    assert.equal(
      second.memory.exportProject(second.projectId).records.some(
        (entry) => entry.digest === committedMemoryDigest,
      ),
      true,
    );

    const afterEvents = await second.events.read(created.caseId);
    assert.deepEqual(afterEvents, beforeEvents);

    // Simulate a second crash before the terminal cache became durable.
    // The already-attested ledger stays byte-for-byte unchanged.
    await second.close();
    await Promise.all([
      rm(join(root, "cases", created.caseId, "terminal.json")),
      rm(join(root, "cases", created.caseId, "terminal.dsse.json")),
    ]);
    await new CaseRepository(root).updateStatus(created.caseId, {
      lifecycle: "crystallized",
      stage: "sign",
      stageStatus: "working",
      lastSequence: beforeEvents.length,
      headDigest: beforeEvents.at(-1)?.eventDigest ?? null,
    });
    second = undefined;
    third = runtimeAt(root);
    await third.ready();
    assert.equal((await third.events.read(created.caseId)).length, afterEvents.length);
    assert.equal((await third.repository.status(created.caseId))?.lifecycle, "terminated");

    // The cache may already be terminal when staging needs a retry. This path
    // must restore the same candidate without changing any public closure.
    await third.close();
    const retryDb = new DatabaseSync(join(root, "memory", "temporal-deep.sqlite"));
    retryDb.prepare("DELETE FROM memories WHERE digest = ?").run(committedMemoryDigest);
    retryDb.close();
    fourth = runtimeAt(root);
    await fourth.ready();
    assert.equal(fourth.memory.exportProject(fourth.projectId).records.some(entry => entry.digest === committedMemoryDigest), true);
    assert.deepEqual(await fourth.events.read(created.caseId), beforeEvents);
    assert.equal((await fourth.repository.status(created.caseId))?.lifecycle, "terminated");
  } finally {
    await first.close();
    await second?.close();
    await third?.close();
    await fourth?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("one data directory admits one daemon and HTTP listen waits for recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-lease-"));
  const first = runtimeAt(root);
  let service: ReturnType<typeof createJevyrHttpService> | undefined;
  try {
    await first.ready();
    assert.throws(() => runtimeAt(root), /already owned by daemon/);
    await first.close();
    const interrupted = await new CaseRepository(root).create({
      protocol: "jevyr.case/1",
      case: { impulse: "HTTP must not observe this case before restart reconciliation" },
    });

    const recoveredRuntime = runtimeAt(root);
    service = createJevyrHttpService({ runtime: recoveredRuntime });
    const address = await service.listen(0, "127.0.0.1");
    const response = await fetch(`${address.url}/v1/cases/${interrupted.caseId}`);
    assert.equal(response.status, 200);
    const status = await response.json() as { lifecycle: string; stageStatus: string };
    assert.equal(status.lifecycle, "invalid");
    assert.equal(status.stageStatus, "failed");
  } finally {
    await first.close();
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("data-directory lease ownership rejects ambiguous and malformed persisted JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-lease-json-"));
  const lease = join(root, ".daemon-lease");
  const owner = join(lease, "owner.json");
  try {
    await mkdir(lease);
    await writeFile(
      owner,
      '{"protocol":"jevyr.daemon-lease/0","protocol":"jevyr.daemon-lease/1","instanceId":"hostile","pid":1,"hostname":"elsewhere","acquiredAt":"2026-09-04T12:00:00.000Z"}',
      "utf8",
    );
    assert.throws(() => runtimeAt(root), /locked by an unreadable lease/u);

    const malformed = Buffer.from('{"protocol":"jevyr.daemon-lease/1","instanceId":"hostile-byte","pid":1,"hostname":"elsewhere","acquiredAt":"2026-09-04T12:00:00.000Z"}', "utf8");
    const marker = malformed.indexOf("hostile-byte");
    assert.ok(marker >= 0);
    malformed[marker] = 0xff;
    await writeFile(owner, malformed);
    assert.throws(() => runtimeAt(root), /locked by an unreadable lease/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
