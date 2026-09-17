import assert from "node:assert/strict";
import test from "node:test";
import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import type { ToolObservation } from "../src/contracts.js";
import { encodeToolObservation, exactByteCapture } from "../src/evidence-artifacts.js";
import { executionFeedback, executionFeedbackFacts, LEGACY_REVISION_INVESTIGATION_POLICY, REVISION_INVESTIGATION_POLICY,
  REVISION_OUTPUT_POLICY, revisionInvestigationEnabled, revisionInvestigationVersion, type FeedbackInput } from "../src/revision-investigation.js";

function input(stdout: string | Uint8Array, stderr = "", invocationId = "physical-1"): FeedbackInput {
  const observation: ToolObservation = { invocationId, status: "failed", summary: "Fixture physical process result",
    startedAt: "2026-09-05T00:00:00.000Z", finishedAt: "2026-09-05T00:00:00.010Z", exitCode: 1,
    oracle: { execution: { state: "exited", mode: "docker", command: "node", args: ["probe.mjs"], shell: false, exitCode: 1,
      stdoutCapture: exactByteCapture(typeof stdout === "string" ? Buffer.from(stdout) : stdout), stderrCapture: exactByteCapture(Buffer.from(stderr)), outputTruncated: false } } };
  return { candidateId: "candidate-parent", assayId: "sealed-probe", observationDigest: encodeToolObservation(observation).digest,
    observation, admissible: true, costUnits: 1,
    evaluation: { obligationId: "experiment_context_only", status: "FAILED", decisive: true, reason: "Observed nonzero exit" } };
}
function replaceObservation(original: FeedbackInput, observation: ToolObservation): FeedbackInput {
  return { ...original, observation, observationDigest: digestJson(observation as unknown as JsonValue) };
}
const facts = (inputs: readonly FeedbackInput[], disclose = true) => executionFeedbackFacts(executionFeedback(inputs), inputs, disclose);
const body = (value: ReturnType<typeof facts>[number]) => JSON.parse(value.body!);

test("current Forge byte-only captures deliver actual stdout and stderr without injecting expected values", () => {
  const entry = input('{"actual":-2}\n', "ERR_MODULE_NOT_FOUND\n");
  const before = digestJson(entry as unknown as JsonValue), result = body(facts([entry])[0]!);
  assert.equal(entry.observation.oracle!.execution.stdout, undefined);
  assert.equal(result.stdout, '{"actual":-2}\n'); assert.equal(result.stderr, "ERR_MODULE_NOT_FOUND\n");
  assert.equal(result.outputCapture.stdout.status, "CAPTURED");
  assert.equal(result.outputCapture.stdout.digest, sha256Digest(result.stdout));
  assert.equal(result.outputCapture.stdout.complete, true); assert.equal(result.outputCapture.stdout.truncated, false);
  assert.equal(result.authority, "context-only; consult bound Forge evidence");
  assert.equal(Object.hasOwn(result, "expected"), false); assert.equal(Object.hasOwn(result, "verified"), false);
  assert.equal(digestJson(entry as unknown as JsonValue), before);
});

test("repeated physical attempts use their own exact binding even when input order differs", () => {
  const entries = [input("first", "missing file", "attempt-1"), input("second", "syntax error", "attempt-2")];
  const feedback = executionFeedback(entries);
  const projected = executionFeedbackFacts(feedback, [...entries].reverse(), true);
  assert.deepEqual(projected.map(value => body(value).stderr), ["missing file", "syntax error"]);
  assert.notEqual(projected[0]!.id, projected[1]!.id);
  const repeated = input("first", "missing file", "attempt-with-another-timestamp");
  assert.equal(facts([repeated])[0]!.id, projected[0]!.id);
});

test("the last sixteen cells retain the correct physical index and both stream byte ceilings", () => {
  const entries = Array.from({ length: 20 }, (_, index) => input(String(index), `error-${index}`, `attempt-${index}`));
  const projected = facts(entries);
  assert.equal(projected.length, REVISION_OUTPUT_POLICY.maxCells);
  assert.deepEqual(projected.map(value => body(value).stdout), Array.from({ length: 16 }, (_, index) => String(index + 4)));
  const result = body(facts([input("x".repeat(1999) + "🙂" + "tail", "é".repeat(1500))])[0]!);
  assert.equal(Buffer.byteLength(result.stdout), 1999); assert.equal(Buffer.byteLength(result.stderr), 2000);
  assert.equal(result.stdout.includes("�"), false); assert.equal(result.stderr.includes("�"), false);
  assert.equal(result.outputCapture.stdout.truncated, true); assert.equal(result.outputCapture.stdout.complete, true);
});

test("partial retained captures expose only their real prefix and explicit incompleteness", () => {
  const original = input("prefix"), execution = original.observation.oracle!.execution;
  const updated = replaceObservation(original, { ...original.observation, oracle: { execution: { ...execution,
    stdoutCapture: exactByteCapture(Buffer.from("prefix"), 100), outputTruncated: true } } });
  const result = body(facts([updated])[0]!);
  assert.equal(result.stdout, "prefix"); assert.equal(result.outputCapture.stdout.complete, false);
  assert.equal(result.outputCapture.stdout.observedBytes, 100); assert.equal(result.outputCapture.stdout.retainedBytes, 6);
  assert.equal(result.outputCapture.stdout.truncated, true);
});

test("invalid UTF-8 is never converted into invented replacement text; a real BOM is preserved", () => {
  const invalid = body(facts([input(Uint8Array.from([0xff, 0xfe]))])[0]!);
  assert.equal(invalid.stdout, ""); assert.equal(invalid.outputCapture.stdout.status, "INVALID_UTF8");
  assert.equal(invalid.outputCapture.stdout.displayBytes, 0);
  const bom = body(facts([input("\ufeffobserved\n")])[0]!);
  assert.equal(bom.stdout, "\ufeffobserved\n");
});

test("rehashing malformed, ambiguous or conflicting captures never makes their text usable", () => {
  const original = input("retained", "error"), execution = original.observation.oracle!.execution, capture = execution.stdoutCapture!;
  for (const change of [
    { stdoutCapture: { ...capture, digest: sha256Digest("foreign") } },
    { stdoutCapture: { ...capture, data: "%%%=" } },
    { stdoutCapture: { ...capture, surprise: "secret-value" } },
    { stdout: "contradicting legacy secret-value" },
    { stdoutCapture: { ...capture, byteLength: 9000 } },
  ]) {
    const changed = replaceObservation(original, { ...original.observation, oracle: { execution: { ...execution, ...change } } } as ToolObservation);
    const result = body(facts([changed])[0]!);
    assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
    assert.equal(result.outputCapture.stdout.status, "INVALID_CAPTURE");
    assert.equal(JSON.stringify(result).includes("secret-value"), false);
  }
});

test("legacy text alone is explicitly absent rather than treated as captured output", () => {
  const original = input("retained"), { stdoutCapture: _stdout, stderrCapture: _stderr, ...execution } = original.observation.oracle!.execution;
  const changed = replaceObservation(original, { ...original.observation, oracle: { execution: { ...execution, stdout: "legacy-only" } } });
  const result = body(facts([changed])[0]!);
  assert.equal(result.stdout, ""); assert.equal(result.outputCapture.stdout.status, "ABSENT");
});

test("missing, changed and foreign observation bindings cannot select another same-cell output", () => {
  const original = input("original"), other = input("foreign", "", "other");
  const feedback = executionFeedback([original]);
  for (const entries of [[], [other], [{ ...other, observationDigest: original.observationDigest }]]) {
    const result = body(executionFeedbackFacts(feedback, entries, true)[0]!);
    assert.equal(result.stdout, ""); assert.equal(result.outputCapture.stdout.status, "UNBOUND_OBSERVATION");
  }
  const changedCell = { ...feedback, cells: [{ ...feedback.cells[0]!, exitCode: 0 }] };
  assert.equal(body(executionFeedbackFacts(changedCell, [original], true)[0]!).outputCapture.stdout.status, "UNBOUND_OBSERVATION");
});

test("private output scopes do not inspect input objects or disclose capture digests", () => {
  const original = input("private-value"), feedback = executionFeedback([original]);
  let reads = 0;
  const hostile = new Proxy([] as FeedbackInput[], { get() { reads++; throw new Error("Input must remain unread"); } });
  const projected = executionFeedbackFacts(feedback, hostile, false), result = body(projected[0]!);
  assert.equal(reads, 0); assert.equal(result.output, "WITHHELD_BY_PRIVACY_SCOPE");
  assert.equal(Object.hasOwn(result, "outputCapture"), false);
  assert.equal(JSON.stringify(projected).includes("private-value"), false);
  assert.equal(JSON.stringify(projected).includes(original.observation.oracle!.execution.stdoutCapture!.digest), false);
});

test("nested capture accessors are rejected without invocation", () => {
  const original = input("retained"), feedback = executionFeedback([original]);
  let reads = 0;
  const capture = { ...original.observation.oracle!.execution.stdoutCapture! };
  Object.defineProperty(capture, "data", { enumerable: true, get() { reads++; return "secret-value"; } });
  const changed = { ...original, observation: { ...original.observation, oracle: { execution: { ...original.observation.oracle!.execution, stdoutCapture: capture } } } };
  const result = body(executionFeedbackFacts(feedback, [changed], true)[0]!);
  assert.equal(reads, 0); assert.equal(result.stdout, ""); assert.equal(result.outputCapture.stdout.status, "INVALID_CAPTURE");
});

test("new revision policy is sealed explicitly and exact historical critical-only policy remains recognizable", () => {
  const descriptor = (executionRevisions: unknown) => ({ policy: { executionRevisions } });
  assert.equal(revisionInvestigationVersion(descriptor(REVISION_INVESTIGATION_POLICY)), "observed-comparative-repair");
  assert.equal(revisionInvestigationVersion(descriptor(LEGACY_REVISION_INVESTIGATION_POLICY)), "legacy-critical-only");
  assert.equal(revisionInvestigationEnabled(descriptor({ ...REVISION_INVESTIGATION_POLICY, maximumBaselineRounds: 3 })), false);
  assert.equal(revisionInvestigationEnabled(descriptor({ ...REVISION_INVESTIGATION_POLICY, extraAuthority: true })), false);
  assert.equal(revisionInvestigationVersion({}), undefined);
});
