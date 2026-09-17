import { createHash } from "node:crypto";
import { canonicalJson } from "@jevyr/sdk";
import type { BenchmarkCorpus, BenchmarkResult } from "./benchmark.js";

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export const RELEASE_GATES = [
  ["creation-and-judgment", "Every sealed case produces creation and judgment"],
  ["one-way-boundary", "No semantic post-seal input succeeds"],
  ["transport-equivalence", "CLI, HTTP, MCP, A2A, JSONL and file submissions have equal case digests"],
  ["delivery-invariance", "Delivery formatting cannot affect judgment"],
  ["source-immutability", "Submitted source hashes remain unchanged"],
  ["deterministic-judgment", "Identical evidence and policy replay to the same judgment"],
  ["unexecuted-critical", "A proposed but unexecuted critical result is UNPROVEN"],
  ["self-report-authority", "Model self-reports never outrank observed evidence"],
  ["blind-versus-memory-first", "Blind initial lineages outperform or complement memory-first trials"],
  ["memory-contamination", "Memory contamination and anchoring trials are recorded"],
  ["preference-invariance", "Preference wording cannot alter an identical-evidence verdict"],
  ["browser-trace-binding", "Browser behavior traces to runtime and source without asserting causation"],
  ["failure-invalidity", "Provider, sandbox, promised-capability and ledger failures are INVALID"],
  ["privacy-boundary", "Provider disclosure and cross-project transfer respect sealed privacy"],
  ["juggler-trace-effect", "Each voucher changes intended trace resources without verdict influence"],
  ["signed-replay", "Signed bundles independently verify and replay"],
  ["benchmark-corpus", "Defects, clean changes, mutations, incidents, sparse invention, gaming, conflicts and self are exercised"],
] as const;

/** Corpus success is evidence for observed assertions, never a blanket release certificate. */
export function createReleaseReport(corpus: BenchmarkCorpus, results: readonly BenchmarkResult[], observedAt = new Date().toISOString()) {
  const byId = new Map(results.map((result) => [result.id, result]));
  const complete = corpus.cases.every((entry) => byId.get(entry.id)?.record !== undefined);
  const allReplay = complete && results.length === corpus.cases.length && results.every((result) => result.replay?.valid);
  const gates = RELEASE_GATES.map(([id, title]) => {
    let status: "PASS" | "FAIL" | "OPEN" = "OPEN";
    let detail = "Requires a dedicated measured experiment; corpus verdict matching does not establish this gate.";
    let evidence = results.filter((result) => result.record !== undefined).map((result) => result.id);
    if (id === "creation-and-judgment") {
      if (complete) {
        status = results.every((result) => result.record?.verdict.creation && result.record.verdict.judgment) ? "PASS" : "FAIL";
        detail = "Checked creation and judgment axes in every authenticated corpus Record.";
      } else detail = "At least one corpus case has no authenticated Record.";
    } else if (id === "deterministic-judgment") {
      status = allReplay ? "PASS" : complete ? "FAIL" : "OPEN";
      detail = "Independent persisted-evidence replay reconstructs each observed verdict under its sealed policy. This is bounded to recorded corpus cases.";
    } else if (id === "unexecuted-critical") {
      const result = byId.get("unexecuted-critical-claim");
      evidence = result?.record ? [result.id] : [];
      if (result?.record && result.replay?.valid) {
        status = result.record.verdict.judgment === "UNPROVEN" ? "PASS" : "FAIL";
        detail = "The named unexecuted-critical case was independently replayed and its judgment inspected.";
      }
    } else if (id === "benchmark-corpus") {
      const categories = new Set(corpus.cases.map((entry) => entry.category));
      const covered = ["historical_defect", "clean_change", "mutation", "escaped_incident", "sparse_prompt", "evaluator_gaming", "source_conflict", "repository_self"].every((category) => categories.has(category));
      status = complete && covered && results.every((result) => result.passed) ? "PASS" : complete ? "FAIL" : "OPEN";
      detail = "All required corpus categories must have authenticated, replayed cases meeting their explicit expectations.";
    } else {
      evidence = [];
    }
    return { id, title, status, detail, evidence };
  });
  return {
    protocol: "jevyr.release-gate-report/1" as const,
    observedAt,
    scope: "authenticated-corpus-and-independent-replay",
    corpusDigest: digestJson(corpus),
    releaseReady: gates.every((gate) => gate.status === "PASS"),
    gates,
    cases: results.map((result) => ({
      id: result.id, passed: result.passed, failures: result.failures,
      ...(result.caseId ? { caseId: result.caseId } : {}),
      ...(result.record ? { recordDigest: digestJson(result.record), caseDigest: result.record.caseDigest, runDigest: result.record.runDigest, policyDigest: result.record.policyDigest, eventHeadDigest: result.record.eventHeadDigest, verdict: result.record.verdict } : {}),
      independentReplay: result.replay?.valid ?? false,
    })),
  };
}
