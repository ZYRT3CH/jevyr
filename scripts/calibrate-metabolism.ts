import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { JsonValue, MetabolicKind, MetabolicReceipt, MetabolicResourceVector, SealedCase } from "../packages/protocol/src/index.js";
import type { MindRequest, PublicContribution, MetabolicCalibrationAction, MetabolicCalibrationTrial, MetabolicCalibrationReport } from "../packages/runtime/src/index.js";
import { finiteOracleSource as oracleSource, finitePythonSource, finiteFailingScentSource } from "../benchmarks/metabolic-fixtures.mjs";

// The default deliberately measures packaged JS, exactly as the installed daemon runs.
const source = process.argv.includes("--development") ? "src" : "dist";
const P = await import(`../packages/protocol/${source}/index.js`);
const C = await import(`../packages/core/${source}/index.js`);
const R = await import(`../packages/runtime/${source}/index.js`);
const Prompt = await import(`../packages/runtime/${source}/adapters/prompt.js`);
const outArg = process.argv.indexOf("--output");
const output = resolve(outArg < 0 ? `artifacts/metabolic-calibration-${Date.now()}` : process.argv[outArg + 1]!);
const seedsArg = process.argv.indexOf("--seeds");
const seeds = seedsArg < 0 ? 64 : Number(process.argv[seedsArg + 1]);
if (!Number.isInteger(seeds) || seeds < 1 || seeds > 512) throw new TypeError("--seeds must be from 1 through 512; fewer than64 is diagnostic only");
await mkdir(join(output, "artifacts"), { recursive: true });
const hash = (value: unknown): string => P.digestJson(value as JsonValue);
const zero = (): Record<keyof MetabolicResourceVector, number> => Object.fromEntries(P.METABOLIC_RESOURCE_KEYS.map((key: string) => [key, 0])) as Record<keyof MetabolicResourceVector, number>;
const stored = new Set<string>();
async function artifact(value: unknown): Promise<string> {
  const bytes = P.canonicalize(value as JsonValue); const digest = P.sha256Digest(bytes);
  if (!stored.has(digest)) { await writeFile(join(output, "artifacts", `${digest.slice(7)}.json`), bytes); stored.add(digest); }
  return digest;
}
const suite = {
  protocol: "jevyr.metabolic-finite-suite/1", seeds, doses: [0, 1, 2], repetitions: 2,
  fixtureProvider: "deterministic-instrumented-finite-mutation-provider", processEngine: process.execPath,
  fixtureSourceDigest: P.sha256Digest(await readFile(new URL("../benchmarks/metabolic-fixtures.mjs", import.meta.url))),
  recallAuthority: "independent host oracle over four planted arithmetic/order defects; not a Forge attestation or model-quality estimate",
  mutationCases: ["stable-unique-order", "signed-sum", "clamp-upper", "first-index"],
  baselinePreservation: "same complete actual provider baseline before supplemental execution; Inertia adds actual failing-probe history before its threshold decision",
  fixedEvidence: "independently checked finite-sequence formal counterexample; dosage carries no policy authority",
};
const suiteDigest = await artifact(suite);
const impulse = "Success means `node experiment.mjs` exits with code 0.";
const contract = C.compileIntentContract({ impulse });
const fixedContract = C.compileIntentContract({ impulse: "Build a finite lossless encoder that maps every possible finite byte string to a strictly shorter byte string." });
const certificate = C.constructFormalCounterexamples(fixedContract)[0];
assert.ok(certificate);
const events = [C.createCaseEvent({ caseDigest: suiteDigest, runDigest: suiteDigest, observedAt: "2026-09-05T00:00:00.000Z", stage: "assay", kind: "evidence.observed", actor: { id: "jevyr.bone", kind: "kernel" }, payload: { evidenceId: "finite-certificate", evidenceType: "tool_observation", summary: "Independently checked finite counterexample used as fixed calibration evidence.", contentDigest: hash(certificate), formalProof: certificate } }, 1, null)];
const verdict = (): unknown => C.compileVerdict(C.projectEvents(events, { intentContract: fixedContract, formalProofKernelDigest: C.FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST }).input);
const evidenceDigest = await artifact({ contract: fixedContract, certificate, events, checkerDigest: C.FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST });
const baselineVerdictDigest = await artifact(verdict());
assert.equal((verdict() as { judgment: string }).judgment, "REJECT");
const search = P.createSearchEnvelope({ ...R.DEFAULT_SEARCH_PROFILE, nursery: { minimumAttempts: 3, saturationWindow: 2, independentLineages: 1, challengeInterval: 10 }, resources: { ...R.DEFAULT_SEARCH_PROFILE.resources, concurrentLineages: 1 } });
const frontier = R.compileAssayFrontier([
  { assayId: "finite.baseline.node", costUnits: 1, tool: "forge.command", args: { command: "node", args: ["experiment.mjs"] } },
  { assayId: "finite.refraction.python-order", costUnits: 1, tool: "forge.command", args: { command: "python3", args: ["order.py"] } },
  { assayId: "finite.refraction.python-sign", costUnits: 1, tool: "forge.command", args: { command: "python3", args: ["sign.py"] } },
], search.profile.resources);
const experimentCapability = R.compileExperimentCapability(frontier, contract);

async function runOracle(seed: number, sources: readonly string[], programs: readonly { executable: string; source: string }[]): Promise<{ defects: MetabolicCalibrationTrial["defects"]; digest: string }> {
  const sourceText = oracleSource(seed);
  const execution = spawnSync(process.execPath, ["--input-type=module", "-"], { input: sourceText, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true });
  if (execution.error || execution.status !== 0) throw new Error(`Finite host oracle could not execute: ${execution.error?.message ?? execution.stderr}`);
  const rows = JSON.parse(execution.stdout) as { id: string; actual: unknown; expected: unknown; detected: boolean }[];
  for (const row of rows) assert.equal(row.detected, hash(row.actual) !== hash(row.expected));
  assert.deepEqual(rows.map((row) => row.id), suite.mutationCases);
  const sourceExecutions = [];
  for (const program of programs.filter((program, index) => programs.findIndex((entry) => entry.source === program.source && entry.executable === program.executable) === index)) {
    const engine = program.executable === "node" ? process.execPath : process.platform === "win32" ? "python" : "python3";
    const args = program.executable === "node" ? ["--input-type=module", "-"] : ["-I", "-"];
    const measured = spawnSync(engine, args, { input: program.source, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true });
    const expectedExit = [finiteFailingScentSource(seed, 1), finiteFailingScentSource(seed, 2)].includes(program.source) ? 9 : 0;
    if (measured.error || measured.status !== expectedExit) throw new Error(`Generated finite probe failed its exact expected exit check: ${measured.error?.message ?? measured.stderr}`);
    sourceExecutions.push({ engine, args, sourceText: program.source, sourceDigest: P.sha256Digest(program.source), exitCode: measured.status, stdout: measured.stdout, stderr: measured.stderr });
  }
  return { defects: rows.map((row) => ({ id: row.id, expected: "REJECT", observed: row.detected ? "REJECT" : "ACCEPT" })), digest: await artifact({ protocol: "jevyr.metabolic-host-oracle/1", sourceText, sourceDigest: P.sha256Digest(sourceText), sourceArtifacts: sources, engine: process.execPath, exitCode: execution.status, stdout: execution.stdout, stderr: execution.stderr, rows, sourceExecutions }) };
}

function receipt(sealed: SealedCase, kind: MetabolicKind, dose: number): MetabolicReceipt {
  const grant = Object.fromEntries(P.METABOLIC_RESOURCE_KEYS.map((key: keyof MetabolicResourceVector) => [key, Math.ceil(search.profile.resources[key] / search.profile.resources.maxMindInvocations) * dose])) as MetabolicResourceVector;
  const quantities = Object.fromEntries(P.METABOLIC_KINDS.map((entry: string) => [entry, entry === kind ? dose : 0]));
  const body = { protocol: "jevyr.metabolism-receipt/1", caseId: sealed.caseId, caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest, searchDigest: search.digest, allowanceDigest: suiteDigest, calibrationDigest: suiteDigest, ballId: `ball_${"a".repeat(43)}`, kind, quantity: dose, sequence: 1, previousReceiptDigest: null, issuedAt: "2026-09-05T00:00:00.000Z", grant, cumulativeGrant: grant, cumulativeQuantities: quantities, work: Object.fromEntries(P.METABOLIC_WORK_KEYS.map((key: string) => [key, key === P.METABOLIC_WORK_FOR_KIND[kind] ? dose : 0])), baselineUnchanged: true, verdictAuthority: "none" };
  return { ...body, digest: hash(body) } as MetabolicReceipt;
}

async function trial(seedNumber: number, kind: MetabolicKind, dose: number): Promise<Omit<MetabolicCalibrationTrial, "replicationTraceDigest" | "replicationDefectsDigest">> {
  const seed = seedNumber.toString(16).padStart(64, "0"); const runDigest = hash({ suiteDigest, seed });
  const sealed: SealedCase = { protocol: "jevyr.case/1", caseId: `case_calibration_${seedNumber}`, submissionDigest: suiteDigest, subjectMaterialCaptureDigest: suiteDigest, caseDigest: suiteDigest, runDigest, sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "bone-v1", policyDigest: suiteDigest, genomeVersion: "baseline", genomeDigest: suiteDigest, intentContractDigest: contract.digest, intentContract: contract, searchEnvelope: search, intent: { impulse, mode: "auto", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control: "juggler", seed }, subjects: [] };
  const trace: MetabolicCalibrationAction[] = []; const sourceArtifacts: string[] = []; const programs: { executable: string; source: string }[] = [];
  let baselineCalls = 0;
  let inertiaDecision: import("../packages/runtime/src/inertia-scent.js").InertiaContinuationDecision | undefined;
  let inertiaReceipt: MetabolicReceipt | undefined;
  let revisionBase: Omit<MindRequest, "signal"> | undefined;
  let revisionContext: import("../packages/runtime/src/revision-investigation.js").RevisionInvocationContext | undefined;
  let revisionParentSources: MindRequest["revisionSources"];
  class InstrumentedMind extends R.RuleMindAdapter {
    override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
      const additive = request.constraints.find((value) => value.startsWith("Additive "));
      const observedKind = (request.revision ? "Inertia" : additive?.split(" ")[1]) as MetabolicKind | undefined;
      const phase = request.constraints.find((value) => value.startsWith("Nursery phase ")) ?? `Execution revision ${request.revision?.round} parent ${request.revision?.parentCandidateIds[0]}`;
      const target = request.constraints.find((value) => value.startsWith("Refraction must produce"))?.match(/experiment ([^ .]+(?:\.[^ .]+)*)\./u)?.[1];
      const experiment = experimentCapability.experiments.find((entry: {assayId:string}) => entry.assayId === target) ?? experimentCapability.experiments[0];
      const visible = request.publicFacts.filter((fact) => ["candidate", "repair"].includes(fact.kind));
      if (observedKind === "Fission") { assert.equal(visible.length, 0); assert.match(phase, /EXILE/u); }
      if (observedKind === "Polarity") { assert.equal(request.role, "challenger"); assert.ok(visible.length > 0); }
      if (observedKind === "Inertia") { assert.equal(request.stage, "reflex"); assert.equal(request.revision?.parentCandidateIds.length, 1); assert.equal(request.revisionSources?.length, 1); assert.ok(visible.length > 0); }
      if (observedKind === "Refraction") assert.ok(target && experiment.assayId !== "finite.baseline.node");
      const variant = !observedKind && kind === "Inertia" ? Math.min(2, ++baselineCalls) : 0;
      const content = variant > 0 ? finiteFailingScentSource(seedNumber, variant) : experiment.command.executable === "python3" ? finitePythonSource(seedNumber, experiment.assayId) : oracleSource(seedNumber);
      const contribution: PublicContribution = { id: `candidate_${request.seed.slice(0, 16)}`, kind: "candidate", summary: observedKind ? `${observedKind} finite probe ${request.seed}` : `Finite baseline mutation suite ${seed}${variant > 0 ? ` variant ${variant}` : ""}`, body: content, tags: ["finite-calibration-fixture"], ...(request.revision ? { parentIds: request.revision.parentCandidateIds } : {}), candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: experiment.entryFile, content }], command: { executable: experiment.command.executable, args: experiment.command.args } } };
      const { signal: _signal, ...capturedRequest } = request;
      const observed = { protocol: "jevyr.metabolic-generator-observation/1", request: capturedRequest, seed: request.seed, role: request.role, constraints: request.constraints, visibleCandidateIds: visible.map((value) => value.id), experiment: experiment.assayId, source: content, contribution, promptDigest: P.sha256Digest(request.preparedPublicPrompt ?? ""), origin: observedKind ?? "baseline", ...(observedKind === "Inertia" ? { inertiaDecision, inertiaReceipt, revisionBase, revisionContext, revisionParentSources, revision: request.revision } : {}) };
      const observationDigest = await artifact(observed); sourceArtifacts.push(observationDigest);
      programs.push({ executable: experiment.command.executable, source: content });
      trace.push({ id: `call:${request.seed}`, origin: observedKind ?? "baseline", metric: observedKind ? P.METABOLIC_WORK_FOR_KIND[observedKind] : "baseline", family: experiment.assayId, lane: phase.split("lineage ")[1]?.replace(/\.$/u, "") ?? phase, observationDigest });
      yield contribution;
    }
  }
  const input = { sealed, minds: [new InstrumentedMind()], publicFacts: [], experimentCapability, signal: new AbortController().signal, observe: async (observation: { audit?: { kind: string; seedCommitment?: string; lineageId?: string } }) => {
    if (observation.audit?.kind !== "lineage_commitment") return;
    const index = trace.findIndex((entry) => P.sha256Digest(entry.id.slice(5)) === observation.audit!.seedCommitment);
    assert.ok(index >= 0, "Runtime lineage commitment has no matching measured call");
    const entry = trace[index]!;
    trace[index] = { ...entry, lane: observation.audit.lineageId!, observationDigest: await artifact({ protocol: "jevyr.metabolic-lineage-observation/1", generatorObservationDigest: entry.observationDigest, audit: observation.audit }) };
  } };
  const baseline = await R.runAdaptiveSearch(input);
  assert.equal(baseline.nursery.termination, "HYPOTHESIS_SATURATED");
  const inertiaObservations: import("../packages/runtime/src/inertia-scent.js").ScentObservation[] = [];
  const inertiaArtifacts: string[] = [];
  const feedbackInputs: import("../packages/runtime/src/revision-investigation.js").FeedbackInput[] = [];
  if (kind === "Inertia") {
    assert.equal(baseline.hypotheses.length, 2);
    for (const [candidateIndex, candidate] of baseline.hypotheses.entries()) {
      const sourceText = (candidate.candidateBlueprintSource as { files: { content: string }[] }).files[0]!.content;
      assert.ok([finiteFailingScentSource(seedNumber, 1), finiteFailingScentSource(seedNumber, 2)].includes(sourceText));
      for (let repetition = 0; repetition < (candidateIndex === 0 ? 4 : 8); repetition++) {
        const observed = spawnSync(process.execPath, ["--input-type=module", "-"], { input: sourceText, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true });
        assert.equal(observed.error, undefined); assert.equal(observed.status, 9);
        const observedDigest = await artifact({ protocol: "jevyr.metabolic-scent-execution/1", candidateId: candidate.id, repetition, sourceText, sourceDigest: P.sha256Digest(sourceText), exitCode: observed.status, stdout: observed.stdout, stderr: observed.stderr, assayId: "finite.baseline.node", obligationId: contract.criticalObligations[0]!.id, costUnits: 1, expectedExitCode: 0 });
        inertiaArtifacts.push(observedDigest);
        inertiaObservations.push({ candidateId: candidate.id, observationDigest: observedDigest, assayId: "finite.baseline.node", obligationId: contract.criticalObligations[0]!.id, status: "FAILED", decisive: true, costUnits: 1 });
        feedbackInputs.push({ candidateId: candidate.id, assayId: "finite.baseline.node", observationDigest: observedDigest, costUnits: 1, admissible: true, evaluation: { obligationId: contract.criticalObligations[0]!.id, oracleKind: "command_exit_code", status: "FAILED", decisive: true, reason: "Measured host fixture exits9 against the exact exit0 oracle; method context only." }, observation: { invocationId: `scent_${observedDigest.slice(-24)}`, status: "failed", summary: "Actual trusted local fixture execution; not a Forge attestation.", startedAt: "2026-09-05T00:00:00.000Z", finishedAt: "2026-09-05T00:00:00.000Z", exitCode: 9, oracle: { execution: { state: "exited", mode: "trusted-host", command: "node", args: ["--input-type=module", "-"], shell: false, exitCode: 9, stdout: observed.stdout, stderr: observed.stderr } } } });
      }
    }
    assert.equal(R.maximumInertiaQuantity(inertiaObservations, contract.criticalObligations.map(value => value.id), 0, 2), 2);
  }
  const addedResourceUse = zero();
  if (dose > 0) {
    const grant = receipt(sealed, kind, dose);
    if (kind === "Inertia") { inertiaReceipt = grant; inertiaDecision = R.planInertiaContinuation(grant, inertiaObservations, contract.criticalObligations.map(value => value.id)); }
    if (kind === "Inertia") {
      const unit = Object.fromEntries(Object.entries(grant.grant).map(([key, value]) => [key, Math.floor(value / dose)])) as unknown as MetabolicResourceVector;
      const feedback = R.executionFeedback(feedbackInputs), feedbackArtifactDigest = await artifact(feedback); inertiaArtifacts.push(feedbackArtifactDigest);
      for (const scent of inertiaDecision!.selected) {
        const parent = baseline.hypotheses.find(value => value.id === scent.candidateId)!;
        const blueprint = R.compileCandidateBlueprint(parent.candidateBlueprintSource, R.compileJevyrIgnorePolicy(output, Buffer.from("")));
        revisionParentSources = [{ candidateId: parent.id, blueprintDigest: blueprint.blueprintDigest, files: blueprint.files }];
        revisionContext = { round: 1, feedback, inputs: feedbackInputs, parentCandidateIds: [parent.id], feedbackArtifactDigest, receiptDigest: grant.digest, receiptSequence: grant.sequence, resourceCeiling: unit };
        revisionBase = { sealed, stage: "reflex", role: "reflex", publicFacts: baseline.hypotheses, experimentCapability, seed: R.investigationSeed(sealed, "mind", ["reflex", 0, input.minds[0].capability.id]), constraints: [], maxInputTokens: unit.maxInputTokens, maxOutputTokens: unit.maxOutputTokens };
        const draft = R.buildExecutionRevisionRequest({ ...revisionBase, signal: AbortSignal.timeout(Math.max(1, unit.maxWallMillis)) }, revisionContext, revisionParentSources, "none");
        const request = { ...draft, preparedPublicPrompt: Prompt.makePublicMindPrompt(draft) };
        const started = performance.now(), invoked = await R.invokeExecutionRevision(input.minds[0], request), elapsed = Math.ceil(performance.now() - started);
        assert.equal(invoked.admissionProblem, undefined); assert.equal(invoked.result.contributions.length, 1); assert.deepEqual(invoked.result.contributions[0].parentIds, [parent.id]);
        assert.ok(invoked.result.tokenUsage.input.tokens <= unit.maxInputTokens && invoked.result.tokenUsage.output.tokens <= unit.maxOutputTokens && invoked.result.receivedOutputBytes <= unit.maxGeneratedBytes && elapsed <= unit.maxWallMillis);
        addedResourceUse.maxMindInvocations++; addedResourceUse.maxInputTokens += invoked.result.tokenUsage.input.tokens; addedResourceUse.maxOutputTokens += invoked.result.tokenUsage.output.tokens; addedResourceUse.maxGeneratedBytes += invoked.result.receivedOutputBytes; addedResourceUse.maxWallMillis += elapsed;
      }
    } else {
      const added = await R.runSupplementalInvestigation(input, grant, { baselineHypotheses: baseline.hypotheses, baselineSaturated: baseline.nursery.termination === "HYPOTHESIS_SATURATED", targetAssayId: "finite.refraction.python-order", targetAssayIds: ["finite.refraction.python-order", "finite.refraction.python-sign"] });
      const usage = added.nursery.resources;
      Object.assign(addedResourceUse, { maxMindInvocations: usage.mindInvocations, maxInputTokens: usage.inputTokens, maxOutputTokens: usage.outputTokens, maxWallMillis: usage.wallMillis, maxGeneratedBytes: usage.generatedBytes });
    }
    assert.equal(addedResourceUse.maxMindInvocations, dose, "Every promised finite work unit must actually run");
  }
  const meterDigest = await artifact({ protocol: "jevyr.metabolic-local-meter/1", kind, seed, dose, addedResourceUse,
    wallMeasurement: "UNSIGNED_LOCAL_MONOTONIC_CLOCK", wallAuthority: "retained bounded host measurement; not independently reproducible or remotely attested",
    traceDigest: hash(trace) });
  const oracle = await runOracle(seedNumber, sourceArtifacts, programs);
  const doseVerdictDigest = await artifact(verdict());
  return { seed, dose, trace, defects: oracle.defects, identicalEvidence: { evidenceDigest, baselineVerdictDigest, doseVerdictDigest }, observationArtifactDigests: [meterDigest, oracle.digest, evidenceDigest, baselineVerdictDigest, doseVerdictDigest, ...inertiaArtifacts], addedResourceUse };
}

const reports: { kind: MetabolicKind; digest: string; valid: boolean; problem?: string }[] = [];
for (const kind of P.METABOLIC_KINDS as MetabolicKind[]) {
  const trials: MetabolicCalibrationTrial[] = [];
  let baselineTrace: readonly MetabolicCalibrationAction[] = [];
  for (let seed = 0; seed < seeds; seed++) for (const dose of [0, 1, 2]) {
    const first = await trial(seed, kind, dose); const replica = await trial(seed, kind, dose);
    if (dose === 0) baselineTrace = first.trace;
    assert.equal(hash(first.trace.slice(0, baselineTrace.length)), hash(baselineTrace), "An additive arm changed its actual baseline trace");
    assert.equal(hash(replica.trace), hash(first.trace), "Repeated scheduler trace changed");
    assert.equal(hash(replica.defects), hash(first.defects), "Repeated mutation-oracle outcomes changed");
    const additions = first.trace.slice(baselineTrace.length);
    assert.equal(additions.length, dose);
    if (kind === "Refraction" || kind === "Fission") {
      const dimension = kind === "Refraction" ? "family" : "lane";
      assert.equal(new Set(additions.map((action) => action[dimension])).size, dose, "A dose did not add distinct measured templates or lanes");
      assert.ok(additions.every((action) => !baselineTrace.some((original) => original[dimension] === action[dimension])));
    }
    trials.push({ ...first, observationArtifactDigests: [...new Set([...first.observationArtifactDigests, ...replica.observationArtifactDigests])], replicationTraceDigest: hash(replica.trace), replicationDefectsDigest: hash(replica.defects) });
  }
  const body = { protocol: "jevyr.metabolic-calibration/1", kind, scope: `Finite deterministic provider: ${seeds} paired seeds, actual baseline nursery and ${kind === "Inertia" ? "production-shared post-execution revision requests, metering and parent-bound admission after trusted-host failed probes" : "supplemental scheduler calls"}, four host-executed planted mutation oracles, repeated traces, fixed formal-evidence kernel verdict. Forge execution is verified separately. Wall time is an unsigned bounded local clock reading; tokens and generated bytes are independently reconstructed. Does not estimate live-model efficacy or general unseen-defect recall.`, implementationDigest: R.metabolicImplementationDigest(), suiteDigest, confidence: 0.95, nonInferiorityMargin: 0.1, trials };
  const report = { ...body, digest: hash(body) } as MetabolicCalibrationReport;
  await writeFile(join(output, `${kind}.json`), P.canonicalize(report as unknown as JsonValue));
  try { const verified = R.verifyMetabolicCalibration(report); await writeFile(join(output, `${kind}.verified.json`), JSON.stringify(verified, null, 2)); reports.push({ kind, digest: report.digest, valid: true }); }
  catch (error) { reports.push({ kind, digest: report.digest, valid: false, problem: error instanceof Error ? error.message : String(error) }); }
  console.log(JSON.stringify(reports.at(-1)));
}
await writeFile(join(output, "report.json"), JSON.stringify({ protocol: "jevyr.metabolic-calibration-run/1", output, suiteDigest, source, reports, scope: suite, completed: reports.every((report) => report.valid), empiricalModelCalibration: false }, null, 2));
console.log(output);
if (!reports.every((report) => report.valid)) process.exitCode = 1;
