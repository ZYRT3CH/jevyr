import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeExactByteCapture } from "../src/evidence-artifacts.js";
import { runBoundedProcess } from "../src/process.js";

async function emit(bytes: readonly number[], maxOutputBytes = 64): ReturnType<typeof runBoundedProcess> {
  return await runBoundedProcess({
    command: process.execPath,
    args: ["-e", `process.stdout.write(Buffer.from([${bytes.join(",")}]))`],
    timeoutMs: 5_000,
    maxOutputBytes,
    terminateOnOutputLimit: true,
  });
}

test("bounded processes distinguish invalid UTF-8 streams that replacement text collapses", async () => {
  const [left, right] = await Promise.all([emit([0x80]), emit([0x81])]);
  assert.equal(left.stdout, right.stdout, "legacy display strings demonstrate the replacement collision");
  assert.equal(left.stdoutCapture.utf8, "invalid");
  assert.equal(right.stdoutCapture.utf8, "invalid");
  assert.notEqual(left.stdoutCapture.digest, right.stdoutCapture.digest);
  assert.notEqual(left.stdoutCapture.data, right.stdoutCapture.data);
  assert.deepEqual([...decodeExactByteCapture(left.stdoutCapture).bytes], [0x80]);
  assert.deepEqual([...decodeExactByteCapture(right.stdoutCapture).bytes], [0x81]);
});

test("bounded processes expose partial bytes and actual observed byte counts after truncation", async () => {
  const result = await emit([0x61, 0x62, 0x63, 0x64], 1);
  assert.equal(result.terminationReason, "output-limit");
  assert.equal(result.truncated, true);
  assert.equal(result.stdoutCapture.byteLength, 1);
  assert.ok(result.stdoutCapture.observedByteLength > result.stdoutCapture.byteLength);
  assert.equal(result.stdoutCapture.complete, false);
  assert.equal(result.outputBytes, result.stdoutCapture.observedByteLength + result.stderrCapture.observedByteLength);
  assert.deepEqual([...decodeExactByteCapture(result.stdoutCapture).bytes], [0x61]);
});

test("bounded processes reject a retention ceiling outside the exact-capture envelope", async () => {
  await assert.rejects(
    runBoundedProcess({
      command: process.execPath,
      args: ["-e", ""],
      maxOutputBytes: 2_000_001,
    }),
    /0 through 2000000/,
  );
});
