import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILURE_CATEGORY_ORDER, PRIOR_OVERRIDE_PROTOCOL, attemptFailureCategories, priorOverrideSummary, providerFailureKind } from "./prior-override-measurement.mjs";

const checksOf = overrides => ({ fullReplay: true, correctJudgment: true, immutableTruthObserved: true, actualModelCandidate: true, actualSourceInspection: true, everyModelCandidateAssayed: true, everyExecutedProbeMatches: true, ...overrides });
const row = (classification, { executed = true, exitCode = 0, matched = classification === "MATCHES_ACTUAL", candidateId = "cand" } = {}) => ({ artifactDigest: `sha256:${"a".repeat(64)}`, candidateId, executed, exitCode, classification, matched, reason: null });
const planned = (attemptId, providerId, caseKey) => ({ attemptId, providerId, seed: "b".repeat(64), repeat: 0, caseKey, directory: `attempt-${attemptId}` });
const manifest = () => ({ planned: [planned("001", "mind.a", "gen-00-x-clean"), planned("002", "mind.a", "gen-00-x-defect"), planned("003", "mind.b", "gen-01-y-defect"), planned("004", "mind.b", "gen-02-z-defect")],
  corpus: { cases: [
    { caseKey: "gen-00-x-clean", pairKey: "gen-00-x", template: "shifted-clamp", expectedJudgment: "ACCEPT" },
    { caseKey: "gen-00-x-defect", pairKey: "gen-00-x", template: "shifted-clamp", expectedJudgment: "REJECT" },
    { caseKey: "gen-01-y-defect", pairKey: "gen-01-y", template: "tail-sum-modulo", expectedJudgment: "REJECT" },
    { caseKey: "gen-02-z-defect", pairKey: "gen-02-z", template: "shifted-clamp", expectedJudgment: "REJECT" }] } });

test("prior-override counters exclude clean attempts, keep unexecuted defective attempts in the attempt denominator and split by provider and template", () => {
  const verification = { attempts: [
    { attemptId: "001", checks: checksOf({}), probeRows: [row("MATCHES_ACTUAL")] },
    { attemptId: "002", checks: checksOf({ everyExecutedProbeMatches: false }), probeRows: [row("MATCHES_INTENDED"), row("MATCHES_ACTUAL", { candidateId: "revision" })] },
    { attemptId: "003", checks: checksOf({ everyExecutedProbeMatches: false }), probeRows: [row("NEITHER", { exitCode: 0 }), row("MALFORMED", { exitCode: 1 })] },
    { attemptId: "004", qualified: false, error: "replay failed" }] };
  const summary = priorOverrideSummary({ manifest: manifest(), verification });
  assert.equal(summary.protocol, PRIOR_OVERRIDE_PROTOCOL); assert.equal(summary.authority, "diagnostic-only");
  assert.equal(summary.cleanAttempts, 1); assert.equal(summary.defectiveAttempts, 3); assert.equal(summary.executedProbes, 4); assert.equal(summary.unexecuted, 1);
  assert.equal(summary.matchesActual, 1); assert.equal(summary.matchesIntended, 1); assert.equal(summary.neither, 1); assert.equal(summary.malformed, 1);
  assert.equal(summary.attemptsWithOverride, 1); assert.equal(summary.priorOverrideRateByProbe, 0.25); assert.equal(summary.priorOverrideRateByAttempt, 1 / 3);
  assert.deepEqual(summary.firstProbe, { matchesActual: 0, matchesIntended: 1, neither: 1, malformed: 0 });
  assert.equal(summary.byProvider["mind.a"].defectiveAttempts, 1); assert.equal(summary.byProvider["mind.a"].matchesIntended, 1); assert.equal(summary.byProvider["mind.b"].unexecuted, 1);
  assert.equal(summary.byTemplate["shifted-clamp"].defectiveAttempts, 2); assert.equal(summary.byTemplate["tail-sum-modulo"].executedProbes, 2);
  assert.equal(summary.attempts.length, 4); assert.equal(summary.attempts[3].verified, false); assert.equal(summary.attempts[0].defective, false);
  const empty = priorOverrideSummary({ manifest: { planned: [], corpus: { cases: [] } }, verification: { attempts: [] } });
  assert.equal(empty.priorOverrideRateByProbe, null); assert.equal(empty.priorOverrideRateByAttempt, null);
  assert.throws(() => priorOverrideSummary({ manifest: { planned: [planned("009", "mind.a", "missing")], corpus: { cases: [] } }, verification: { attempts: [] } }));
});

test("failure categories follow the fixed precedence, extract provider failure kinds and vanish for a qualified attempt", () => {
  const invocations = { invocations: [{ status: "RETURNED" }, { status: "FAILED", error: "Provider round ceiling reached (TOOL_CALL_CEILING)" }, { status: "FAILED", error: "opaque" }] };
  const failing = attemptFailureCategories({ checked: { checks: checksOf({ actualSourceInspection: false, correctJudgment: false }), probeRows: [row("MATCHES_INTENDED"), row("MALFORMED", { exitCode: 1 })] }, result: { closeError: "close" }, invocations, defective: true });
  assert.deepEqual(failing.categories, ["PROVIDER_FAILURE", "NO_SOURCE_INSPECTION", "PROBE_CRASHED", "PROBE_PRIOR_OVERRIDE", "WRONG_JUDGMENT", "RUNTIME_CLOSE_ERROR"]);
  assert.equal(failing.primary, "PROVIDER_FAILURE"); assert.deepEqual(failing.providerFailureKinds, ["TOOL_CALL_CEILING", "UNCLASSIFIED"]);
  assert.deepEqual(attemptFailureCategories({ checked: { qualified: false, error: "replay" }, result: {}, invocations: { invocations: [] }, defective: true }).categories, ["REPLAY_FAILURE"]);
  assert.deepEqual(attemptFailureCategories({ checked: { checks: checksOf({ everyExecutedProbeMatches: false }), probeRows: [row("MATCHES_INTENDED")] }, result: {}, invocations: { invocations: [] }, defective: false }).categories, ["PROBE_OUTPUT_MISMATCH"], "a clean fixture cannot register a prior override");
  assert.deepEqual(attemptFailureCategories({ checked: { checks: checksOf({ everyModelCandidateAssayed: false }), probeRows: [] }, result: {}, invocations: { invocations: [] }, defective: true }).categories, ["PROBE_NOT_EXECUTED"]);
  const qualified = attemptFailureCategories({ checked: { checks: checksOf({}), probeRows: [row("MATCHES_ACTUAL")] }, result: {}, invocations: { invocations: [{ status: "RETURNED" }] }, defective: false });
  assert.deepEqual(qualified, { categories: [], primary: null, providerFailureKinds: [] });
  assert.equal(providerFailureKind("Final contribution missing (FINAL_CONTRIBUTION)"), "FINAL_CONTRIBUTION"); assert.equal(providerFailureKind(undefined), "UNCLASSIFIED");
  assert.equal(FAILURE_CATEGORY_ORDER.length, 10);
});
