import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Digest } from "@jevyr/protocol";
import {
  decodeToolObservation,
  decodeExactByteCapture,
  encodeToolObservation,
  exactByteCapture,
  MAX_TOOL_OBSERVATION_BYTES,
  type ToolObservation,
} from "../src/index.js";

function observation(): ToolObservation {
  return {
    invocationId: "invocation_exact",
    status: "succeeded",
    summary: "Measured, not asserted.",
    startedAt: "2026-09-04T12:00:00.000Z",
    finishedAt: "2026-09-04T12:00:00.010Z",
    exitCode: 0,
    stdout: "ok\n",
    metadata: { z: 2, a: true },
  };
}

test("ToolObservation artifacts have one deterministic canonical representation", () => {
  const encoded = encodeToolObservation(observation());
  assert.equal(encoded.digest, sha256Digest(encoded.bytes));
  assert.equal(encoded.size, encoded.bytes.byteLength);
  assert.match(new TextDecoder().decode(encoded.bytes), /^\{"exitCode":0,"finishedAt":/u);
  assert.deepEqual(decodeToolObservation(encoded.bytes), observation());

  const reordered: ToolObservation = {
    metadata: { a: true, z: 2 },
    stdout: "ok\n",
    exitCode: 0,
    finishedAt: "2026-09-04T12:00:00.010Z",
    startedAt: "2026-09-04T12:00:00.000Z",
    summary: "Measured, not asserted.",
    status: "succeeded",
    invocationId: "invocation_exact",
  };
  assert.equal(encodeToolObservation(reordered).digest, encoded.digest);
});

test("ToolObservation decoding rejects alternate spellings and malformed authority", () => {
  const pretty = new TextEncoder().encode(JSON.stringify(observation(), null, 2));
  assert.throws(() => decodeToolObservation(pretty), /not canonical Jevyr JSON/);
  assert.throws(
    () => encodeToolObservation({ ...observation(), decidesVerdict: true } as unknown as ToolObservation),
    /unknown fields/,
  );
  assert.throws(
    () => encodeToolObservation({ ...observation(), artifactRefs: ["artifact_bad"] }),
    /artifactRefs/,
  );
  assert.throws(
    () => decodeToolObservation(new Uint8Array(MAX_TOOL_OBSERVATION_BYTES + 1)),
    /permits at most/,
  );
});

test("ToolObservation validation never invokes accessor properties", () => {
  let invoked = false;
  const hostile = { ...observation() } as Record<string, unknown>;
  Object.defineProperty(hostile, "summary", {
    enumerable: true,
    get() {
      invoked = true;
      return "forged";
    },
  });
  assert.throws(() => encodeToolObservation(hostile as unknown as ToolObservation), /data properties/);
  assert.equal(invoked, false);

  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, "claim", {
    enumerable: true,
    get() {
      invoked = true;
      return "authority";
    },
  });
  assert.throws(
    () => encodeToolObservation({ ...observation(), metadata: nested }),
    /canonical JSON/,
  );
  assert.equal(invoked, false);
});

test("exact byte captures reject aliases, false digests, false UTF-8, and incomplete pairs", () => {
  const invalid = exactByteCapture(Uint8Array.from([0x80]));
  const empty = exactByteCapture(new Uint8Array());
  const { stdout, ...withoutStdout } = observation();
  void stdout;
  const exact: ToolObservation = {
    ...withoutStdout,
    stdoutCapture: invalid,
    stderrCapture: empty,
  };
  const encoded = encodeToolObservation(exact);
  assert.deepEqual(decodeToolObservation(encoded.bytes), exact);
  assert.deepEqual([...decodeExactByteCapture(invalid).bytes], [0x80]);
  const duplicate = new TextEncoder().encode(
    new TextDecoder().decode(encoded.bytes).replace(
      "\"byteLength\":1",
      "\"byteLength\":1,\"\\u0062yteLength\":1",
    ),
  );
  assert.throws(() => decodeToolObservation(duplicate), /not valid JSON/);

  assert.throws(
    () => decodeExactByteCapture({ ...invalid, data: "gA" }),
    /canonical base64/,
  );
  assert.throws(
    () => decodeExactByteCapture({ ...invalid, digest: `sha256:${"0".repeat(64)}` }),
    /digest/,
  );
  assert.throws(
    () => decodeExactByteCapture({ ...invalid, utf8: "valid" }),
    /UTF-8 status/,
  );
  assert.throws(
    () => decodeExactByteCapture({ ...invalid, complete: false }),
    /completeness/,
  );
  assert.throws(
    () => encodeToolObservation({ ...exact, stdout: "�" }),
    /must be absent when exact bytes are invalid UTF-8/,
  );
  assert.throws(
    () => encodeToolObservation({ ...observation(), stdoutCapture: exactByteCapture(Buffer.from("ok\n")) }),
    /both stdout and stderr/,
  );
});

test("nested Forge captures bind display text and truncation canonically", () => {
  const stdoutCapture = exactByteCapture(Buffer.from("ok\n", "utf8"));
  const stderrCapture = exactByteCapture(new Uint8Array());
  const exact: ToolObservation = {
    ...observation(),
    oracle: {
      execution: {
        state: "exited",
        mode: "trusted-host",
        command: "fixture",
        args: [],
        shell: false,
        exitCode: 0,
        stdoutCapture,
        stderrCapture,
        outputTruncated: false,
      },
    },
  };
  assert.doesNotThrow(() => encodeToolObservation(exact));
  assert.throws(
    () => encodeToolObservation({ ...exact, stdout: "replacement" }),
    /does not equal the exact UTF-8 bytes/,
  );
  assert.throws(
    () => encodeToolObservation({
      ...exact,
      oracle: {
        execution: {
          ...exact.oracle?.execution,
          outputTruncated: true,
        },
      },
    }),
    /outputTruncated/,
  );
});
