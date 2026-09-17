import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CaseRepository, FileEventHub, RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";

test("the public daemon surface exposes neither Record signing nor ledger append authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-sign-boundary-"));
  const runtime = createDaemonRuntime({
    dataDir: root,
    minds: [new RuleMindAdapter()],
    forge: new SealedForgeAdapter({ mode: "observe-only" }),
  });
  try {
    await runtime.ready();
    assert.equal("writeRecord" in runtime.repository, false);
    assert.equal("writeRecoveryRecord" in runtime.repository, false);
    assert.equal("writeTerminalReceipt" in runtime.repository, false);
    assert.equal("create" in runtime.repository, false);
    assert.equal("updateStatus" in runtime.repository, false);
    assert.equal(Reflect.get(runtime.repository, "writeRecord"), undefined);
    assert.equal(Reflect.get(runtime.repository, "writeRecoveryRecord"), undefined);
    assert.equal(Reflect.get(runtime.repository, "writeTerminalReceipt"), undefined);
    assert.equal(Reflect.get(runtime.repository, "create"), undefined);
    assert.equal(Reflect.get(runtime.repository, "updateStatus"), undefined);
    assert.equal("append" in runtime.events, false);
    assert.equal("subscribe" in runtime.events, false);
    assert.equal(Reflect.get(runtime.events, "append"), undefined);
    assert.equal(Reflect.get(runtime.events, "subscribe"), undefined);
    assert.equal(Object.isFrozen(runtime.events), true);
    assert.equal(Reflect.get(runtime.orchestrator, "config"), undefined);
    assert.deepEqual(Object.keys(runtime.orchestrator).sort(), ["abort", "abortAll", "cast", "metabolismOffers", "redeemMetabolism", "redeemVoucher", "vouchers", "waitForTerminal"]);
    assert.equal("writeMetabolicReceipt" in runtime.repository, false);
    for (const method of ["continue", "message", "approve", "verdict", "sign", "append"]) assert.equal(Reflect.get(runtime.orchestrator, method), undefined);
    assert.throws(() => runtime.orchestrator.redeemVoucher("case_boundary_12345678", { verdict: "ACCEPT" }));
    await assert.rejects(
      Reflect.apply(CaseRepository.prototype.writeRecord, runtime.repository, ["case_boundary_12345678", {}]),
      /unforgeable repository authority/u,
    );
    await assert.rejects(
      Reflect.apply(CaseRepository.prototype.writeTerminalReceipt, runtime.repository, ["case_boundary_12345678", {}]),
      /unforgeable repository authority/u,
    );
    await assert.rejects(
      Reflect.apply(FileEventHub.prototype.append, runtime.events, [{ caseId: "case_boundary_12345678" }]),
    );

    const created = await runtime.orchestrator.cast({
      protocol: "jevyr.case/1",
      case: { impulse: "Only Bone may cross the signing boundary" },
    });
    assert.equal((await runtime.orchestrator.waitForTerminal(created.caseId, 10_000)).lifecycle, "terminated");
    assert.ok(await runtime.repository.recordEnvelope(created.caseId));
    assert.ok(await runtime.repository.terminalEnvelope(created.caseId));
    const observed = await runtime.events.list(created.caseId, 0, 1);
    const first = observed.events[0];
    assert.ok(first);
    (first as { sequence: number }).sequence = 999;
    assert.equal((await runtime.events.list(created.caseId, 0, 1)).events[0]?.sequence, 1);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
