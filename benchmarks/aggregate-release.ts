import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { canonicalJson } from "../packages/sdk/src/index.js";
import { compileIntentContract } from "../packages/core/src/index.js";
import { verifyLocalProof } from "../apps/cli/src/local-proof.js";
import { loadCorpus } from "../apps/cli/src/benchmark.js";
import { RELEASE_GATES } from "../apps/cli/src/release-report.js";
// Measurement parsers and experiment verifiers deliberately remain independent
// from their stored PASS flags.
import { protocolExperiments, parseTapChecks, parseVitestChecks } from "./protocol-experiments.mjs";
import { verifyBlindMemory } from "./verify-blind-memory.mjs";
import { verifyBrowserProof } from "./verify-browser-proof.mjs";

const hash = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const digest = (value: unknown) => hash(canonicalJson(value));
type Gate = { id: string; title: string; status: "PASS" | "FAIL" | "OPEN"; scope: string; evidence: string[] };
const gates: Gate[] = RELEASE_GATES.map(([id, title]) => ({ id, title, status: "OPEN", scope: "No complete measured evidence supplied.", evidence: [] }));
const gate = (id: string) => gates.find((entry) => entry.id === id)!;
const args = process.argv.slice(2);
const options = new Map<string, string[]>();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]!, value = args[index + 1];
  if (!["--protocol-report", "--lifecycle-report", "--corpus-report", "--memory-report", "--output"].includes(key) || !value) throw new TypeError(`Invalid release intake argument ${key}`);
  options.set(key, [...(options.get(key) ?? []), value]);
}
const documents = [];
const read = async (path: string) => {
  const bytes = await readFile(resolve(path));
  if (bytes.length > 64 * 1_048_576) throw new TypeError("Release evidence input is too large");
  documents.push({ path: resolve(path), digest: hash(bytes) });
  return JSON.parse(bytes.toString("utf8"));
};
const checkResults = new Map<string, { status: "PASS" | "FAIL"; path: string; scope: string }>();
for (const path of options.get("--protocol-report") ?? []) {
  const report = await read(path);
  if (report.protocol !== "jevyr.protocol-experiment-report/1") throw new TypeError("Expected measured protocol experiment report");
  for (const result of report.experiments) {
    const definition = protocolExperiments.find((entry) => entry.id === result.id);
    if (!definition || result.outputDigest !== hash(result.output)) throw new TypeError("Experiment definition or output digest is invalid");
    const checks = definition.engine === "vitest" ? parseVitestChecks(result.machineOutput, definition.checks) : parseTapChecks(result.output, definition.checks);
    const sourceMatches = result.sourceBefore === result.sourceAfter && result.sourceAfter === hash(await readFile(resolve(definition.file)));
    for (const check of checks) {
      const status = result.exitCode === 0 && sourceMatches && check.status === "PASS" ? "PASS" : "FAIL";
      checkResults.set(`${definition.id}/${check.name}`, { status, path: resolve(path), scope: definition.scope });
    }
  }
}
for (const entry of gates) {
  const requirements = protocolExperiments.flatMap((experiment) => experiment.checks.filter((check) => check.gates.includes(entry.id)).map((check) => `${experiment.id}/${check.name}`));
  if (!requirements.length) continue;
  const values = requirements.map((key) => checkResults.get(key));
  entry.status = values.some((value) => value?.status === "FAIL") ? "FAIL" : values.every((value) => value?.status === "PASS") ? "PASS" : "OPEN";
  entry.scope = `${requirements.length} named finite protocol/policy checks; PASS establishes those measured inputs, not population-wide model behavior.`;
  entry.evidence = requirements.filter((key) => checkResults.has(key));
}

const lifecycle = [];
for (const path of options.get("--lifecycle-report") ?? []) {
  const report = await read(path);
  if (report.protocol !== "jevyr.lifecycle-proof/1") throw new TypeError("Expected lifecycle proof report");
  const verification = await verifyLocalProof(join(dirname(resolve(path)), "proof"));
  if (verification.valid && (verification.caseId !== report.caseId || digest(verification.verdict) !== digest(report.verdict))) throw new Error("Lifecycle report does not match its independently verified Record");
  lifecycle.push({ path: resolve(path), declaredMode: report.mode, verification });
}
const signed = lifecycle.filter((entry) => entry.verification.valid);
const browserEvidence = [];
for (const entry of signed) {
  if (!entry.verification.artifactMediaTypes?.includes("application/json")) continue;
  const inspection = await verifyBrowserProof(join(dirname(entry.path), "proof"));
  if (inspection.valid || String(entry.declaredMode).startsWith("browser")) browserEvidence.push({ path: entry.path, inspection });
}
if (browserEvidence.length) {
  const complete = browserEvidence.filter((entry) => entry.inspection.valid);
  const positive = complete.some((entry) => entry.inspection.observations.some((observation) => observation.assertionsPassed));
  const negative = complete.some((entry) => entry.inspection.observations.some((observation) => !observation.assertionsPassed));
  Object.assign(gate("browser-trace-binding"), { status: positive && negative ? "PASS" : "OPEN", scope: "Complete positive and negative real-browser traces: signed observation and image authority, exact report/PNG/ZIP artifacts, source/runtime script hashes, coverage ranges, sealed assertions and observed failures. Attribution is explicitly not causation. Earlier incomplete observations remain recorded.", evidence: complete.map((entry) => entry.path) });
}
if (signed.length) {
  for (const id of ["creation-and-judgment", "deterministic-judgment", "signed-replay"]) {
    Object.assign(gate(id), { status: lifecycle.every((entry) => entry.verification.valid) ? "PASS" : "FAIL", scope: "Supplied terminal Cases: three DSSE signatures, full ledger closure, exact artifact inventory and independent persisted-evidence replay. Signer identity is proof-declared unless pinned externally.", evidence: signed.map((entry) => entry.path) });
  }
}

const corpusEvidence = [];
for (const path of options.get("--corpus-report") ?? []) {
  const report = await read(path);
  if (report.protocol !== "jevyr.release-gate-report/1") throw new TypeError("Expected corpus report");
  const root = dirname(resolve(path));
  const corpus = await loadCorpus(join(root, "executed-corpus.json"));
  const canonicalCorpus = await loadCorpus(resolve("benchmarks/corpus.v1.json"));
  const expectedCorpus = { ...canonicalCorpus, cases: canonicalCorpus.cases.map((entry) => entry.category === "repository_self" ? { ...entry, subjects: [{ id: "jevyr-repository", kind: "directory", locator: join(root, "repository-source") }] } : entry) };
  if (digest(corpus) !== digest(expectedCorpus)) throw new Error("Executed corpus differs from canonical requirements; expectations cannot be weakened during intake");
  const sourceManifest = await read(join(root, "repository-source-manifest.json"));
  const snapshotRoot = join(root, "repository-source");
  if (sourceManifest.protocol !== "jevyr.repository-source-snapshot/1" || !Array.isArray(sourceManifest.files)) throw new TypeError("Invalid repository source manifest");
  const sourceChanges = [];
  for (const source of sourceManifest.files) {
    if (typeof source.path !== "string" || isAbsolute(source.path) || source.path.split(/[\\/]/u).some((part) => part === ".." || !part)) throw new TypeError("Unsafe source manifest path");
    const file = resolve(snapshotRoot, source.path);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(file) !== file) throw new TypeError("Source snapshot entry is not an ordinary local file");
    const actual = hash(await readFile(file));
    if (actual !== source.digest) sourceChanges.push({ path: source.path, expected: source.digest, actual });
  }
  if (sourceChanges.length) Object.assign(gate("source-immutability"), { status: "FAIL", scope: "Frozen repository source differs from its pre-run manifest.", evidence: [resolve(path)] });
  else gate("source-immutability").evidence.push(`${resolve(path)}#${sourceManifest.files.length}-frozen-source-hashes`);
  const cases = [];
  for (const entry of corpus.cases) {
    const verification = await verifyLocalProof(join(root, "proofs", entry.id));
    const recorded = report.cases.find((candidate) => candidate.id === entry.id);
    const expected = entry.expect;
    const verdict = verification.valid ? verification.verdict : undefined;
    const expectedContract = compileIntentContract({ impulse: entry.impulse, constraints: entry.constraints ?? [], requestedAssays: entry.requestedAssays ?? [], subjectIds: entry.subjects?.map((subject) => subject.id) ?? [] });
    const matches = verification.valid && recorded?.recordDigest === verification.recordDigest
      && verification.intentContractDigest === expectedContract.digest
      && (["integrity", "creation", "embodiment", "judgment"] as const).every((axis) => expected[axis] === undefined || (expected[axis] === "PRESENT" ? Boolean(verdict?.[axis]) : verdict?.[axis] === expected[axis]));
    cases.push({ id: entry.id, category: entry.category, passed: matches, expected, verification });
  }
  const pairJudgments = new Map<string, string>();
  for (const entry of corpus.cases) {
    if (!entry.pair) continue;
    const observation = cases.find((candidate) => candidate.id === entry.id)!;
    const judgment = observation.verification.verdict?.judgment;
    if (!judgment) { observation.passed = false; continue; }
    if (pairJudgments.has(entry.pair) && pairJudgments.get(entry.pair) !== judgment) observation.passed = false;
    pairJudgments.set(entry.pair, judgment);
  }
  const required = ["historical_defect", "clean_change", "mutation", "escaped_incident", "sparse_prompt", "evaluator_gaming", "source_conflict", "repository_self"];
  const complete = cases.length === corpus.cases.length && cases.every((entry) => entry.verification.valid);
  const passed = complete && cases.every((entry) => entry.passed) && required.every((category) => cases.some((entry) => entry.category === category));
  Object.assign(gate("benchmark-corpus"), { status: passed ? "PASS" : "FAIL", scope: `${cases.length} independently verified corpus Cases, exact declared expectations and all required categories. ${report.investigationMode ?? "Unspecified investigator mode"}.`, evidence: [resolve(path)] });
  const critical = cases.find((entry) => entry.id === "unexecuted-critical-claim");
  if (critical) Object.assign(gate("unexecuted-critical"), { status: critical.verification.valid && critical.verification.verdict?.judgment === "UNPROVEN" ? "PASS" : "FAIL", scope: "Named unexecuted-critical Case and its independently replayed sealed obligations.", evidence: [resolve(path)] });
  corpusEvidence.push({ path: resolve(path), complete, passed, sourceFiles: sourceManifest.files.length, sourceChanges, cases });
}

const memoryEvidence = [];
for (const path of options.get("--memory-report") ?? []) {
  const verified = await verifyBlindMemory(resolve(path));
  memoryEvidence.push(verified);
  Object.assign(gate("blind-versus-memory-first"), { status: verified.comparison.complete && verified.comparison.unmeasuredPairs === 0 && verified.comparison.blindComplementsMemory ? "PASS" : "FAIL", scope: "Counterbalanced local-model paired trials with fixed drivers and offline-recalculated outputs. Bounded complement only; seed enforcement unverified, no population superiority or causal attribution claimed.", evidence: [resolve(path)] });
}

const heterogeneousEvidence = signed.filter((entry) => entry.verification.verdict?.integrity === "VALID" && entry.verification.verdict?.embodiment === "BUILT" && entry.verification.investigators!.filter((id) => id.startsWith("http://127.0.0.1:11434/")).length >= 2).map((entry) => entry.path);
const target = resolve(options.get("--output")?.[0] ?? "artifacts/release-evidence.json");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify({ protocol: "jevyr.aggregated-release-evidence/1", observedAt: new Date().toISOString(), scope: "bounded-local-release-gate-experiments", releaseTarget: "earlier-approved-plan-17-gate-set", fullDsJudgeSpecReady: false, releaseReady: gates.every((entry) => entry.status === "PASS") && heterogeneousEvidence.length > 0, caveat: "Release gate PASS is bounded to the earlier 17-gate set, exact recorded experiments and retained artifacts. It does not certify the newer DS Judge product specification. Local execution reports are not third-party attestations, and this does not establish general-purpose research quality or universal model independence.", command: { executable: "node", arguments: ["apps/cli/node_modules/tsx/dist/cli.mjs", ...(process.execArgv.includes("--conditions=development") ? ["--conditions=development"] : []), "benchmarks/aggregate-release.ts", ...args] }, gates, heterogeneousEvidence, inputDocuments: documents, lifecycle, corpusEvidence, memoryEvidence, browserEvidence }, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${gates.filter((entry) => entry.status === "PASS").length}/${gates.length} measured gates pass within scope: ${target}\n`);
