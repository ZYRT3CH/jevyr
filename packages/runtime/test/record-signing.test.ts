import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digestJson, sha256Digest, type JsonValue, type SignedRecord } from "@jevyr/protocol";
import {
  CaseRepository,
  FileEventHub,
  JevyrOrchestrator,
  RuleMindAdapter,
  SealedForgeAdapter,
} from "../src/index.js";
import { claimRecordCommitAuthority } from "../src/record-authority.js";

async function completedCase(root: string): Promise<{
  readonly repository: CaseRepository;
  readonly events: FileEventHub;
  readonly caseId: string;
  readonly record: SignedRecord;
}> {
  const repository = new CaseRepository(root);
  const events = new FileEventHub(root);
  const orchestrator = new JevyrOrchestrator({
    repository,
    events,
    minds: [new RuleMindAdapter()],
    forge: new SealedForgeAdapter({ mode: "observe-only" }),
  });
  const created = await orchestrator.cast({
    protocol: "jevyr.case/1",
    case: { impulse: "Bind the signer to the exact authenticated crystallization prefix" },
  });
  const terminal = await orchestrator.waitForTerminal(created.caseId, 10_000);
  assert.equal(terminal.lifecycle, "terminated");
  const record = await repository.record(created.caseId);
  assert.ok(record);
  return { repository, events, caseId: created.caseId, record };
}

test("normal signing rejects caller-chosen verdicts and commits the exact derived Record once", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-record-authority-"));
  try {
    const fixture = await completedCase(root);
    const ledger = await fixture.events.read(fixture.caseId);
    const signEnteredIndex = ledger.findIndex((event) =>
      event.kind === "stage.status"
      && event.stage === "sign"
      && event.payload.stage === "sign"
      && event.payload.status === "entered");
    assert.ok(signEnteredIndex > 0);
    const signingLedger = ledger.slice(0, signEnteredIndex + 1);
    await writeFile(
      join(root, "cases", fixture.caseId, "events.ndjson"),
      `${signingLedger.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    await Promise.all([
      rm(join(root, "cases", fixture.caseId, "record.json")),
      rm(join(root, "cases", fixture.caseId, "record.dsse.json")),
      rm(join(root, "cases", fixture.caseId, "terminal.json")),
      rm(join(root, "cases", fixture.caseId, "terminal.dsse.json")),
    ]);
    const signingHead = signingLedger.at(-1);
    assert.ok(signingHead);
    const signingRepository = new CaseRepository(root);
    const authority = claimRecordCommitAuthority(signingRepository);
    await signingRepository.updateStatus(fixture.caseId, {
      lifecycle: "crystallized",
      stage: "sign",
      stageStatus: "working",
      lastSequence: signingHead.sequence,
      headDigest: signingHead.eventDigest,
    });

    const forged: SignedRecord = {
      ...fixture.record,
      verdict: { ...fixture.record.verdict, judgment: "ACCEPT" },
    };
    await assert.rejects(
      Reflect.apply(CaseRepository.prototype.writeRecord, fixture.repository, [fixture.caseId, forged]),
      /unforgeable repository authority/u,
    );
    await assert.rejects(
      signingRepository.writeRecord(fixture.caseId, forged, authority),
      /crystallization commitment|deterministic projection/u,
    );
    await assert.rejects(access(join(root, "cases", fixture.caseId, "record.json")));

    await signingRepository.updateStatus(fixture.caseId, {
      lifecycle: "crystallized",
      stage: "sign",
      stageStatus: "working",
      lastSequence: signingHead.sequence,
      headDigest: `sha256:${"0".repeat(64)}`,
    });
    await assert.rejects(
      signingRepository.writeRecord(fixture.caseId, fixture.record, authority),
      /status cursor/u,
    );
    await signingRepository.updateStatus(fixture.caseId, {
      lifecycle: "crystallized",
      stage: "sign",
      stageStatus: "working",
      lastSequence: signingHead.sequence,
      headDigest: signingHead.eventDigest,
    });

    const sealPath = join(root, "cases", fixture.caseId, "seal.json");
    const authenticSeal = await readFile(sealPath);
    const tamperedSeal = JSON.parse(authenticSeal.toString("utf8")) as Record<string, unknown>;
    tamperedSeal.caseDigest = `sha256:${"0".repeat(64)}`;
    await writeFile(sealPath, `${JSON.stringify(tamperedSeal)}\n`);
    await assert.rejects(
      signingRepository.writeRecord(fixture.caseId, fixture.record, authority),
      /Seal receipt|status does not equal/u,
    );
    await writeFile(sealPath, authenticSeal);

    const envelope = await signingRepository.writeRecord(fixture.caseId, fixture.record, authority);
    assert.ok(envelope.signatures[0]?.sig);
    const committedBytes = await readFile(join(root, "cases", fixture.caseId, "record.json"));
    assert.deepEqual(await fixture.repository.record(fixture.caseId), fixture.record);

    await assert.rejects(
      signingRepository.writeRecord(fixture.caseId, forged, authority),
      /write-once/u,
    );
    assert.deepEqual(await readFile(join(root, "cases", fixture.caseId, "record.json")), committedBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal signing commits the complete ledger and refuses a reauthored tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-terminal-authority-"));
  try {
    const fixture = await completedCase(root);
    const [receipt, envelope, status, ledger] = await Promise.all([
      fixture.repository.terminalReceipt(fixture.caseId),
      fixture.repository.terminalEnvelope(fixture.caseId),
      fixture.repository.status(fixture.caseId),
      fixture.events.read(fixture.caseId),
    ]);
    assert.ok(receipt);
    assert.ok(envelope);
    assert.ok(status);
    assert.equal(receipt.eventHeadDigest, ledger.at(-1)?.eventDigest);
    assert.equal(receipt.lastSequence, ledger.length);
    assert.equal(receipt.recordDigest, digestJson(fixture.record as unknown as JsonValue));
    assert.equal(envelope.payloadType, "application/vnd.jevyr.terminal+json");
    await assert.rejects(
      Reflect.apply(CaseRepository.prototype.writeTerminalReceipt, fixture.repository, [fixture.caseId, {}]),
      /unforgeable repository authority/u,
    );

    const forgedTail = await fixture.events.append({
      caseId: fixture.caseId,
      caseDigest: status.sealed.caseDigest,
      runDigest: status.sealed.runDigest,
      stage: "terminate",
      kind: "action.status",
      actor: { id: "forged-tail", kind: "peer" },
      payload: {
        actionId: "forged-tail",
        actionType: "rewrite-closure",
        status: "completed",
        summary: "An unsigned observer-authored tail must not inherit Bone's closure.",
      },
    });
    await assert.rejects(
      fixture.repository.updateStatus(fixture.caseId, {
        lifecycle: "terminated",
        stage: "terminate",
        stageStatus: "completed",
        lastSequence: forgedTail.sequence,
        headDigest: forgedTail.eventDigest,
      }),
      /Status is closed/u,
    );
    await assert.rejects(
      fixture.repository.terminalReceipt(fixture.caseId),
      /Terminal status does not equal the complete verified event ledger/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal signing commits the exact artifact inventory and closes artifact publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-terminal-artifacts-"));
  try {
    const fixture = await completedCase(root);
    const receipt = await fixture.repository.terminalReceipt(fixture.caseId);
    assert.ok(receipt);
    const artifactIndex = {
      protocol: "jevyr.artifacts/1",
      caseId: fixture.caseId,
      artifacts: await fixture.repository.artifacts(fixture.caseId),
    } as const;
    assert.equal(receipt.artifactIndexDigest, digestJson(artifactIndex as unknown as JsonValue));

    const secondInstance = new CaseRepository(root);
    await assert.rejects(
      secondInstance.putArtifact(fixture.caseId, "late.txt", "text/plain", Buffer.from("late")),
      /Artifacts are closed/u,
    );

    // Even a well-formed artifact injected outside the repository boundary
    // invalidates the already-signed inventory instead of inheriting trust.
    const injected = Buffer.from("externally injected after closure", "utf8");
    const digest = sha256Digest(injected);
    const id = `artifact_${digest.slice("sha256:".length, "sha256:".length + 24)}`;
    const directory = join(root, "cases", fixture.caseId, "artifacts");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${id}.blob`), injected);
    await writeFile(join(directory, `${id}.json`), `${JSON.stringify({
      protocol: "jevyr.artifact/1",
      id,
      caseId: fixture.caseId,
      name: "injected.txt",
      mediaType: "text/plain",
      size: injected.byteLength,
      digest,
      createdAt: receipt.closedAt,
    }, null, 2)}\n`);
    await assert.rejects(
      fixture.repository.terminalReceipt(fixture.caseId),
      /artifact index/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery is invalid-only, fixed-shape, idempotent, and cannot supersede a normal Record", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-authority-"));
  try {
    const repository = new CaseRepository(root);
    const created = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Recovery must be a fixed fail-closed statement" },
    });
    await assert.rejects(
      repository.writeRecoveryRecord(created.caseId, "RUNTIME_FAILURE"),
      /durably invalid/u,
    );
    const detail = "The runtime stopped before semantic execution completed.";
    await repository.updateStatus(created.caseId, {
      lifecycle: "invalid",
      stage: "self_scan",
      stageStatus: "failed",
      lastSequence: 0,
      headDigest: null,
      error: detail,
    });
    const first = await repository.writeRecoveryRecord(created.caseId, "RUNTIME_FAILURE");
    const second = await repository.writeRecoveryRecord(created.caseId, "RUNTIME_FAILURE");
    assert.deepEqual(second, first);
    const recovery = await repository.record(created.caseId);
    assert.ok(recovery);
    assert.equal(recovery.verdict.integrity, "INVALID");
    assert.equal(recovery.verdict.judgment, "NOT_APPLICABLE");
    assert.deepEqual(recovery.verdict.feasibilityByCandidate, {});
    assert.deepEqual(recovery.verdict.basis, [{ code: "RUNTIME_FAILURE", summary: detail, evidenceIds: [] }]);
    assert.deepEqual(recovery.reflex.materialFindings, recovery.verdict.basis);
    assert.equal(recovery.reflex.reviewedEvidenceDigest, recovery.verdict.evidenceDigest);
    await assert.rejects(access(join(root, "cases", created.caseId, "record.json")));
    assert.ok((await readFile(join(root, "cases", created.caseId, "recovery-record.json"))).byteLength > 0);

    const normal = await completedCase(join(root, "normal"));
    const normalStatus = await normal.repository.status(normal.caseId);
    assert.ok(normalStatus);
    await Promise.all([
      rm(join(root, "normal", "cases", normal.caseId, "terminal.json")),
      rm(join(root, "normal", "cases", normal.caseId, "terminal.dsse.json")),
    ]);
    await normal.repository.updateStatus(normal.caseId, {
      lifecycle: "invalid",
      stage: "sign",
      stageStatus: "failed",
      lastSequence: normalStatus.lastSequence,
      headDigest: normalStatus.headDigest,
      error: "A simulated post-commit failure must not authorize recovery replacement.",
    });
    await assert.rejects(
      normal.repository.writeRecoveryRecord(normal.caseId, "RUNTIME_FAILURE"),
      /cannot be superseded/u,
    );
    assert.deepEqual(await normal.repository.record(normal.caseId), normal.record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted recovery pair can only be completed from its matching fixed Record fragment", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-fragment-"));
  try {
    const repository = new CaseRepository(root);
    const created = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Complete recovery without replacing its first durable fragment" },
    });
    await repository.updateStatus(created.caseId, {
      lifecycle: "invalid",
      stage: "self_scan",
      stageStatus: "failed",
      lastSequence: 0,
      headDigest: null,
      error: "Interrupted while publishing the recovery signature.",
    });
    await repository.writeRecoveryRecord(created.caseId, "RUNTIME_RESTART_INTERRUPTED_CASE");
    const path = join(root, "cases", created.caseId, "recovery-record.json");
    const before = await readFile(path);
    await rm(join(root, "cases", created.caseId, "recovery-record.dsse.json"));

    await repository.writeRecoveryRecord(created.caseId, "RUNTIME_RESTART_INTERRUPTED_CASE");
    assert.deepEqual(await readFile(path), before);
    assert.ok(await repository.recordEnvelope(created.caseId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid normal Record material is preserved but cannot block or replace fixed recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-invalid-normal-"));
  try {
    const repository = new CaseRepository(root);
    const created = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Treat malformed normal Record bytes as forensic material only" },
    });
    const recordPath = join(root, "cases", created.caseId, "record.json");
    const envelopePath = join(root, "cases", created.caseId, "record.dsse.json");
    const forgedRecord = Buffer.from("{\"forged\":true}\n");
    const forgedEnvelope = Buffer.from("{\"payloadType\":\"untrusted\"}\n");
    await Promise.all([
      writeFile(recordPath, forgedRecord),
      writeFile(envelopePath, forgedEnvelope),
    ]);
    await repository.updateStatus(created.caseId, {
      lifecycle: "invalid",
      stage: "self_scan",
      stageStatus: "failed",
      lastSequence: 0,
      headDigest: null,
      error: "Malformed normal commitment interrupted recovery.",
    });

    await repository.writeRecoveryRecord(created.caseId, "RUNTIME_FAILURE");
    assert.deepEqual(await readFile(recordPath), forgedRecord);
    assert.deepEqual(await readFile(envelopePath), forgedEnvelope);
    assert.equal((await repository.record(created.caseId))?.verdict.integrity, "INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
