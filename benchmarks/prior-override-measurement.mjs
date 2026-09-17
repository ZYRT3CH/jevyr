import assert from "node:assert/strict";

/** Diagnostic accounting over verified attempts. It has no verdict authority and never changes a strict qualification result. */
export const PRIOR_OVERRIDE_PROTOCOL = "jevyr.prior-override-measurement/1";
export const FAILURE_CATEGORY_ORDER = Object.freeze(["REPLAY_FAILURE", "PROVIDER_FAILURE", "NO_MODEL_CANDIDATE", "NO_SOURCE_INSPECTION", "PROBE_NOT_EXECUTED", "PROBE_CRASHED", "PROBE_PRIOR_OVERRIDE", "PROBE_OUTPUT_MISMATCH", "WRONG_JUDGMENT", "RUNTIME_CLOSE_ERROR"]);
const CLASSIFICATION_COUNTERS = Object.freeze(["matchesActual", "matchesIntended", "neither", "malformed"]);
const counterFor = classification => ({ MATCHES_ACTUAL: "matchesActual", MATCHES_INTENDED: "matchesIntended", NEITHER: "neither", MALFORMED: "malformed" })[classification] ?? "malformed";

export function providerFailureKind(error) {
  const match = /\(([A-Z][A-Z_]*)\)\s*$/u.exec(String(error ?? ""));
  return match ? match[1] : "UNCLASSIFIED";
}

/** Every applicable category is listed in fixed order; `primary` is the first. A qualified attempt yields none. */
export function attemptFailureCategories({ checked, result, invocations, defective }) {
  const checks = checked?.checks ?? null, executed = (checked?.probeRows ?? []).filter(row => row.executed);
  const failedInvocations = (invocations?.invocations ?? []).filter(value => value.status !== "RETURNED");
  const flags = new Set();
  if (!checks?.fullReplay || checked?.error) flags.add("REPLAY_FAILURE");
  if (failedInvocations.length > 0) flags.add("PROVIDER_FAILURE");
  if (checks && !checks.actualModelCandidate) flags.add("NO_MODEL_CANDIDATE");
  if (checks && !checks.actualSourceInspection) flags.add("NO_SOURCE_INSPECTION");
  if (checks && (executed.length === 0 || !checks.everyModelCandidateAssayed)) flags.add("PROBE_NOT_EXECUTED");
  if (executed.some(row => row.exitCode !== 0)) flags.add("PROBE_CRASHED");
  if (defective && executed.some(row => row.exitCode === 0 && row.classification === "MATCHES_INTENDED")) flags.add("PROBE_PRIOR_OVERRIDE");
  if (executed.some(row => row.exitCode === 0 && !row.matched && !(defective && row.classification === "MATCHES_INTENDED"))) flags.add("PROBE_OUTPUT_MISMATCH");
  if (checks && !checks.correctJudgment) flags.add("WRONG_JUDGMENT");
  if (result?.closeError) flags.add("RUNTIME_CLOSE_ERROR");
  const categories = FAILURE_CATEGORY_ORDER.filter(category => flags.has(category));
  return { categories, primary: categories[0] ?? null, providerFailureKinds: failedInvocations.map(value => providerFailureKind(value.error)) };
}

const emptyCounters = () => ({ defectiveAttempts: 0, executedProbes: 0, unexecuted: 0, matchesActual: 0, matchesIntended: 0, neither: 0, malformed: 0, attemptsWithOverride: 0 });
const rates = counters => ({ ...counters,
  priorOverrideRateByProbe: counters.executedProbes === 0 ? null : counters.matchesIntended / counters.executedProbes,
  priorOverrideRateByAttempt: counters.defectiveAttempts === 0 ? null : counters.attemptsWithOverride / counters.defectiveAttempts });

/** `verification` is the output of verifyLiveModelQualification; probe rows are read in artifact-index order, which is the case repository's creation order. */
export function priorOverrideSummary({ manifest, verification }) {
  assert.ok(Array.isArray(manifest?.planned) && Array.isArray(manifest?.corpus?.cases) && Array.isArray(verification?.attempts));
  const total = emptyCounters(), byProvider = {}, byTemplate = {}, firstProbe = Object.fromEntries(CLASSIFICATION_COUNTERS.map(name => [name, 0])), attempts = [];
  let cleanAttempts = 0;
  for (const planned of manifest.planned) {
    const fixture = manifest.corpus.cases.find(entry => entry.caseKey === planned.caseKey); assert.ok(fixture, `Unknown planned case ${planned.caseKey}`);
    const checked = verification.attempts.find(entry => entry.attemptId === planned.attemptId);
    const defective = fixture.expectedJudgment === "REJECT", template = fixture.template ?? "clamp", pairKey = fixture.pairKey ?? "clamp";
    const probes = (checked?.probeRows ?? []).map(row => ({ candidateId: row.candidateId, executed: row.executed, exitCode: row.exitCode ?? null, matched: row.matched, classification: row.classification ?? null }));
    attempts.push({ attemptId: planned.attemptId, providerId: planned.providerId, seed: planned.seed, caseKey: planned.caseKey, pairKey, template, defective, verified: !!checked && !checked.error, probes });
    if (!defective) { cleanAttempts += 1; continue; }
    const executed = probes.filter(row => row.executed);
    for (const counters of [total, byProvider[planned.providerId] ??= emptyCounters(), byTemplate[template] ??= emptyCounters()]) {
      counters.defectiveAttempts += 1; counters.executedProbes += executed.length; if (executed.length === 0) counters.unexecuted += 1;
      for (const row of executed) counters[counterFor(row.classification)] += 1;
      if (executed.some(row => row.classification === "MATCHES_INTENDED")) counters.attemptsWithOverride += 1;
    }
    if (executed.length > 0) firstProbe[counterFor(executed[0].classification)] += 1;
  }
  return { protocol: PRIOR_OVERRIDE_PROTOCOL, authority: "diagnostic-only", ...rates(total), cleanAttempts, firstProbe,
    byProvider: Object.fromEntries(Object.entries(byProvider).map(([key, value]) => [key, rates(value)])),
    byTemplate: Object.fromEntries(Object.entries(byTemplate).map(([key, value]) => [key, rates(value)])), attempts,
    scope: "MATCHES_INTENDED on a defective fixture means the probe reported the specified behavior instead of the observed source. On the generated family the task parameters cannot come from training memory, so this is the co-located specification overriding observation; on the clamp baseline specification recall and training recall are indistinguishable. Unexecuted defective attempts stay in the attempt denominator and outside the probe denominator." };
}
