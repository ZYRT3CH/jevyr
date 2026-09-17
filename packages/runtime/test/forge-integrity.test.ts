import assert from "node:assert/strict";
import { test } from "node:test";
import { forgeIntegrityFailure } from "../src/forge-integrity.js";
import type { ToolObservation } from "../src/contracts.js";

const observation: ToolObservation = {
  invocationId: "fixture", status: "failed", summary: "Untrusted display text.",
  startedAt: "2026-09-05T00:00:00Z", finishedAt: "2026-09-05T00:00:01Z",
};
const boundary = { builtInSandbox: true, adapterThrew: false, interrupted: false };

test("lost startup sandbox and broken execution boundaries invalidate independently of prose", () => {
  assert.equal(forgeIntegrityFailure({ ...observation, metadata: { reason: "docker-unavailable" } }, boundary), "integrity.sandbox_failure");
  assert.equal(forgeIntegrityFailure(observation, { ...boundary, builtInSandbox: false, adapterThrew: true }), "integrity.sandbox_failure");
  for (const metadata of [
    { nonAdmissibleReason: "boundary-or-integrity-failure" },
    { reason: "forge-observation-invalid" },
    { reason: "forge-invocation-id-mismatch" },
  ]) {
    assert.equal(forgeIntegrityFailure({ ...observation, metadata }, boundary), "integrity.capability_loss");
    assert.equal(forgeIntegrityFailure({ ...observation, metadata }, { ...boundary, builtInSandbox: false }), undefined);
  }
});

test("command failure and enforced resource stops remain assay outcomes", () => {
  const exited: ToolObservation = {
    ...observation,
    oracle: { execution: { state: "exited", mode: "docker", command: "node", args: ["check.mjs"], shell: false, exitCode: 9 } },
  };
  assert.equal(forgeIntegrityFailure(exited, boundary), undefined);
  assert.equal(forgeIntegrityFailure(exited, { ...boundary, authorityProblem: "sealed image changed" }), "integrity.capability_loss");
  for (const stopped of [
    { ...observation, metadata: { reason: "bone-cell-deadline" } },
    { ...observation, metadata: { nonAdmissibleReason: "physical-resource-limit" } },
    { ...exited, oracle: { execution: { ...exited.oracle!.execution, state: "timed-out" as const } } },
  ]) assert.equal(forgeIntegrityFailure(stopped, { ...boundary, authorityProblem: "no exited oracle" }), undefined);
  assert.equal(forgeIntegrityFailure(observation, { ...boundary, adapterThrew: true, interrupted: true }), undefined);
  assert.equal(forgeIntegrityFailure({ ...observation, summary: "sandbox missing and boundaries broken" }, boundary), undefined);
});
