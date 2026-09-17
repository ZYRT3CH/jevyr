import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileEventHub } from "../src/events.js";

const CASE_DIGEST = `sha256:${"a".repeat(64)}`;
const RUN_DIGEST = `sha256:${"b".repeat(64)}`;

function ledgerPath(root: string, caseId: string): string {
  return join(root, "cases", caseId, "events.ndjson");
}

async function appendStatus(hub: FileEventHub, caseId: string, index: number): Promise<void> {
  await hub.append({
    caseId,
    caseDigest: CASE_DIGEST,
    runDigest: RUN_DIGEST,
    observedAt: "2026-09-04T12:00:00.000Z",
    stage: "cast",
    kind: "stage.status",
    actor: { id: "bone", kind: "kernel" },
    payload: { stage: "cast", status: index === 0 ? "entered" : "completed", summary: `event-${index}` },
  });
}

async function withLedger(
  name: string,
  count: number,
  operation: (root: string, caseId: string, hub: FileEventHub) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `jevyr-${name}-`));
  const caseId = `case_${name}_12345678`;
  try {
    const hub = new FileEventHub(root);
    for (let index = 0; index < count; index += 1) await appendStatus(hub, caseId, index);
    await operation(root, caseId, hub);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("event ledger scales to thousands of durable events and rebuilds its verified cache after restart", async () => {
  await withLedger("stress", 2_048, async (root, caseId, hub) => {
    assert.equal(await hub.lastSequence(caseId), 2_048);
    const tail = await hub.list(caseId, 2_040, 20);
    assert.deepEqual(tail.events.map((event) => event.sequence), [2_041, 2_042, 2_043, 2_044, 2_045, 2_046, 2_047, 2_048]);
    assert.equal(tail.latestSequence, 2_048);
    assert.equal(tail.nextCursor, 2_048);
    assert.equal(tail.headDigest, tail.events.at(-1)?.eventDigest);

    // Public pages cannot mutate the verified in-memory tail.
    (tail.events[0] as { sequence: number }).sequence = -1;
    assert.equal((await hub.list(caseId, 2_040, 1)).events[0]?.sequence, 2_041);

    const reloaded = new FileEventHub(root);
    const rebuilt = await reloaded.list(caseId, 2_046, 10);
    assert.deepEqual(rebuilt.events.map((event) => event.sequence), [2_047, 2_048]);
    assert.equal(await reloaded.lastSequence(caseId), 2_048);

    // A separately verified, canonical append is accepted as an append-only extension.
    await appendStatus(reloaded, caseId, 2_048);
    const reconciled = await hub.list(caseId, 2_048, 1);
    assert.equal(reconciled.events[0]?.sequence, 2_049);
    assert.equal(reconciled.latestSequence, 2_049);
  });
});

test("event ledger rejects malformed JSON and torn final writes", async (context) => {
  await context.test("malformed UTF-8", async () => {
    await withLedger("malformed_utf8", 1, async (root, caseId, hub) => {
      await appendFile(ledgerPath(root, caseId), Uint8Array.from([0xff, 0x0a]));
      await assert.rejects(hub.list(caseId), /not valid UTF-8/u);
      await assert.rejects(new FileEventHub(root).list(caseId), /not valid UTF-8/u);
    });
  });

  await context.test("malformed complete line", async () => {
    await withLedger("malformed", 1, async (root, caseId, hub) => {
      await appendFile(ledgerPath(root, caseId), "not-json\n", "utf8");
      await assert.rejects(hub.list(caseId), /malformed JSON at line 2/u);
      await assert.rejects(new FileEventHub(root).list(caseId), /malformed JSON at line 2/u);
    });
  });

  await context.test("duplicate event control key", async () => {
    await withLedger("duplicate_key", 1, async (root, caseId) => {
      const path = ledgerPath(root, caseId);
      const original = (await readFile(path, "utf8")).trimEnd();
      const altered = original.replace('"sequence":1', '"sequence":999,"sequence":1');
      assert.notEqual(altered, original);
      await writeFile(path, `${altered}\n`, "utf8");
      await assert.rejects(
        new FileEventHub(root).list(caseId),
        /duplicate object key "sequence"/u,
      );
    });
  });

  await context.test("torn final line", async () => {
    await withLedger("torn_tail", 1, async (root, caseId, hub) => {
      await appendFile(ledgerPath(root, caseId), "{\"protocol\":", "utf8");
      await assert.rejects(hub.list(caseId), /truncated or torn final line/u);
      await assert.rejects(new FileEventHub(root).list(caseId), /truncated or torn final line/u);
    });
  });

  await context.test("blank line", async () => {
    await withLedger("blank_line", 1, async (root, caseId, hub) => {
      await appendFile(ledgerPath(root, caseId), "\n", "utf8");
      await assert.rejects(hub.list(caseId), /malformed blank line at 2/u);
    });
  });
});

test("event ledger detects truncation and removal after verification", async (context) => {
  await context.test("whole-event truncation", async () => {
    await withLedger("truncated", 3, async (root, caseId, hub) => {
      const path = ledgerPath(root, caseId);
      const bytes = await readFile(path);
      const previousNewline = bytes.lastIndexOf(0x0a, bytes.byteLength - 2);
      assert.ok(previousNewline > 0);
      await truncate(path, previousNewline + 1);
      await assert.rejects(hub.list(caseId), /file was truncated/u);
    });
  });

  await context.test("known ledger removal", async () => {
    await withLedger("removed", 1, async (root, caseId, hub) => {
      await unlink(ledgerPath(root, caseId));
      await assert.rejects(hub.lastSequence(caseId), /verified file was removed/u);
    });
  });
});

test("event ledger detects sequence, digest, priorDigest, and exact-prefix rewriting", async (context) => {
  for (const mutation of ["sequence", "eventDigest", "priorDigest", "raw-prefix"] as const) {
    await context.test(mutation, async () => {
      await withLedger(`tamper_${mutation.replace("-", "_")}`, 3, async (root, caseId, hub) => {
        const path = ledgerPath(root, caseId);
        const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
        if (mutation === "raw-prefix") {
          lines[0] = ` ${lines[0]}`;
        } else {
          const event = JSON.parse(lines[1] ?? "null") as Record<string, unknown>;
          if (mutation === "sequence") event.sequence = 9;
          if (mutation === "eventDigest") event.eventDigest = `sha256:${"0".repeat(64)}`;
          if (mutation === "priorDigest") event.priorDigest = `sha256:${"f".repeat(64)}`;
          lines[1] = JSON.stringify(event);
        }
        await writeFile(path, `${lines.join("\n")}\n`, "utf8");
        await assert.rejects(
          hub.list(caseId),
          mutation === "raw-prefix" ? /externally rewritten/u : /sequence_gap|digest_mismatch|prior_mismatch/u,
        );
      });
    });
  }
});

test("event waits honor an already-aborted signal and reject ambiguous numeric controls", async () => {
  await withLedger("wait_controls", 0, async (_root, caseId, hub) => {
    const controller = new AbortController();
    controller.abort();
    const started = performance.now();
    const page = await hub.wait(caseId, 0, 30_000, controller.signal);
    assert.equal(page.events.length, 0);
    assert.ok(performance.now() - started < 1_000);

    await assert.rejects(hub.list(caseId, 0, Number.NaN), /page limit/u);
    await assert.rejects(hub.list(caseId, 0, 1.5), /page limit/u);
    await assert.rejects(hub.wait(caseId, 0, Number.NaN), /wait timeout/u);
    await assert.rejects(hub.wait(caseId, 0, 30_001), /wait timeout/u);
  });
});
