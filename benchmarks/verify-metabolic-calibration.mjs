import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { finiteOracleSource, finitePythonSource, finiteExpectedRows, finiteFailingScentSource } from "./metabolic-fixtures.mjs";

/** Replays only trusted local fixture source, never arbitrary source from an input report. */
export async function verifyMetabolicExperiment(directory, options = {}) {
  const source = options.development ? "src" : "dist";
  const P = await import(`../packages/protocol/${source}/index.js`);
  const R = await import(`../packages/runtime/${source}/index.js`);
  const C = await import(`../packages/core/${source}/index.js`);
  const Prompt = await import(`../packages/runtime/${source}/adapters/prompt.js`);
  const root = resolve(directory);
  const hash = value => P.digestJson(value);
  const cache = new Map();
  const executions = new Map();
  let capturedBytes = 0;
  async function artifact(digest) {
    assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
    if (cache.has(digest)) return cache.get(digest);
    const bytes = await readFile(join(root, "artifacts", `${digest.slice(7)}.json`));
    capturedBytes += bytes.length;
    assert.ok(bytes.length <= 1024 * 1024 && capturedBytes <= 96 * 1024 * 1024);
    assert.equal(P.sha256Digest(bytes), digest);
    const value = JSON.parse(bytes.toString("utf8"));
    assert.equal(P.canonicalize(value), bytes.toString("utf8"));
    cache.set(digest, value); return value;
  }
  function executeTrusted(sourceText, executable, expectedExitCode = 0) {
    const key = hash({ sourceText, executable, expectedExitCode });
    if (executions.has(key)) return executions.get(key);
    const engine = executable === "node" ? process.execPath : process.platform === "win32" ? "python" : "python3";
    const args = executable === "node" ? ["--input-type=module", "-"] : ["-I", "-"];
    const result = spawnSync(engine, args, { input: sourceText, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true });
    if (result.error || result.status !== expectedExitCode) throw new Error(`Trusted finite fixture replay differed from its expected exit: ${result.error?.message ?? result.stderr}`);
    const observed = { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    executions.set(key, observed); return observed;
  }
  const impulse = "Success means `node experiment.mjs` exits with code 0.";
  const contract = C.compileIntentContract({ impulse });
  const search = P.createSearchEnvelope({ ...R.DEFAULT_SEARCH_PROFILE, nursery: { minimumAttempts: 3, saturationWindow: 2, independentLineages: 1, challengeInterval: 10 }, resources: { ...R.DEFAULT_SEARCH_PROFILE.resources, concurrentLineages: 1 } });
  const frontier = R.compileAssayFrontier([
    { assayId: "finite.baseline.node", costUnits: 1, tool: "forge.command", args: { command: "node", args: ["experiment.mjs"] } },
    { assayId: "finite.refraction.python-order", costUnits: 1, tool: "forge.command", args: { command: "python3", args: ["order.py"] } },
    { assayId: "finite.refraction.python-sign", costUnits: 1, tool: "forge.command", args: { command: "python3", args: ["sign.py"] } },
  ], search.profile.resources);
  const experimentCapability = R.compileExperimentCapability(frontier, contract);
  function fixtureSeal(suiteDigest, seedNumber, seed) {
    return { protocol: "jevyr.case/1", caseId: `case_calibration_${seedNumber}`, submissionDigest: suiteDigest, subjectMaterialCaptureDigest: suiteDigest, caseDigest: suiteDigest, runDigest: hash({ suiteDigest, seed }), sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "bone-v1", policyDigest: suiteDigest, genomeVersion: "baseline", genomeDigest: suiteDigest, intentContractDigest: contract.digest, intentContract: contract, searchEnvelope: search, intent: { impulse, mode: "auto", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control: "juggler", seed }, subjects: [] };
  }
  function fixtureReceipt(sealed, kind, dose, suiteDigest) {
    const grant = Object.fromEntries(P.METABOLIC_RESOURCE_KEYS.map(key => [key, Math.ceil(search.profile.resources[key] / search.profile.resources.maxMindInvocations) * dose]));
    const body = { protocol: "jevyr.metabolism-receipt/1", caseId: sealed.caseId, caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest, searchDigest: search.digest, allowanceDigest: suiteDigest, calibrationDigest: suiteDigest, ballId: `ball_${"a".repeat(43)}`, kind, quantity: dose, sequence: 1, previousReceiptDigest: null, issuedAt: "2026-09-05T00:00:00.000Z", grant, cumulativeGrant: grant, cumulativeQuantities: Object.fromEntries(P.METABOLIC_KINDS.map(entry => [entry, entry === kind ? dose : 0])), work: Object.fromEntries(P.METABOLIC_WORK_KEYS.map(key => [key, key === P.METABOLIC_WORK_FOR_KIND[kind] ? dose : 0])), baselineUnchanged: true, verdictAuthority: "none" };
    return { ...body, digest: hash(body) };
  }
  const verified = [];
  const diagnosticProblems = [];
  for (const kind of P.METABOLIC_KINDS) {
    const report = JSON.parse(await readFile(join(root, `${kind}.json`), "utf8"));
    assert.equal(report.kind, kind);
    let calibration;
    try { calibration = R.verifyMetabolicCalibration(report); }
    catch (error) {
      if (options.diagnostic !== true || error.message !== "Calibration needs at least 64 complete paired seeds") throw error;
      diagnosticProblems.push(`${kind}: ${error.message}`);
    }
    const suite = await artifact(report.suiteDigest);
    assert.equal(suite.fixtureSourceDigest, P.sha256Digest(await readFile(new URL("./metabolic-fixtures.mjs", import.meta.url))));
    for (const trial of report.trials) {
      const seed = Number.parseInt(trial.seed, 16);
      assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed < suite.seeds);
      const sealed = fixtureSeal(report.suiteDigest, seed, trial.seed);
      const expectedReceipt = trial.dose > 0 ? fixtureReceipt(sealed, kind, trial.dose, report.suiteDigest) : undefined;
      const meteredUse = Object.fromEntries(P.METABOLIC_RESOURCE_KEYS.map(key => [key, 0]));
      const generatorObservations = [];
      for (const action of trial.trace) {
        let row = await artifact(action.observationDigest);
        if (row.protocol === "jevyr.metabolic-lineage-observation/1") row = await artifact(row.generatorObservationDigest);
        assert.equal(row.protocol, "jevyr.metabolic-generator-observation/1");
        assert.ok(row.request, "A retained exact provider request is required for resource reconstruction");
        generatorObservations.push(row);
      }
      let replayIndex = 0;
      const replayProblems = [];
      class ReplayMind extends R.RuleMindAdapter {
        async *run(request) {
          const observed = generatorObservations[replayIndex++];
          try {
            assert.ok(observed, "Scheduler invoked an unrecorded provider call");
            const { signal: _signal, ...actualRequest } = request;
            assert.deepEqual(actualRequest, observed.request, "Retained request differs from the independently replayed scheduler");
            assert.equal(P.sha256Digest(Prompt.makePublicMindPrompt(request)), observed.promptDigest);
          } catch (error) { replayProblems.push(error); throw error; }
          yield observed.contribution;
        }
      }
      const replayInput = { sealed, minds: [new ReplayMind()], publicFacts: [], experimentCapability, signal: new AbortController().signal };
      const baseline = await R.runAdaptiveSearch(replayInput);
      if (replayProblems.length) throw replayProblems[0];
      assert.equal(baseline.nursery.termination, "HYPOTHESIS_SATURATED");
      assert.equal(replayIndex, trial.trace.filter(action => action.origin === "baseline").length);
      if (trial.dose > 0 && kind !== "Inertia") {
        const replayed = await R.runSupplementalInvestigation(replayInput, expectedReceipt, { baselineHypotheses: baseline.hypotheses, baselineSaturated: true, targetAssayId: "finite.refraction.python-order", targetAssayIds: ["finite.refraction.python-order", "finite.refraction.python-sign"] });
        if (replayProblems.length) throw replayProblems[0];
        const usage = replayed.nursery.resources;
        Object.assign(meteredUse, { maxMindInvocations: usage.mindInvocations, maxInputTokens: usage.inputTokens, maxOutputTokens: usage.outputTokens, maxGeneratedBytes: usage.generatedBytes });
      }
      const hostOracles = [];
      const localMeters = [];
      for (const digest of trial.observationArtifactDigests) {
        const observation = await artifact(digest);
        if (observation.protocol === "jevyr.metabolic-host-oracle/1") hostOracles.push(observation);
        if (observation.protocol === "jevyr.metabolic-local-meter/1") localMeters.push(observation);
      }
      assert.ok(hostOracles.length >= 1);
      for (const oracle of hostOracles) {
        assert.equal(oracle.sourceText, finiteOracleSource(seed));
        assert.equal(oracle.sourceDigest, P.sha256Digest(oracle.sourceText));
        assert.deepEqual(oracle.rows, finiteExpectedRows(seed));
        const observed = executeTrusted(finiteOracleSource(seed), "node");
        assert.equal(oracle.stdout, observed.stdout); assert.equal(oracle.exitCode, observed.exitCode); assert.equal(oracle.stderr, observed.stderr);
        assert.deepEqual(trial.defects, oracle.rows.map(row => ({ id: row.id, expected: "REJECT", observed: row.detected ? "REJECT" : "ACCEPT" })));
        for (const run of oracle.sourceExecutions) {
          const executable = run.args[0] === "--input-type=module" ? "node" : "python3";
          const failingSources = [finiteFailingScentSource(seed, 1), finiteFailingScentSource(seed, 2)];
          const allowed = executable === "node" ? [finiteOracleSource(seed), ...(kind === "Inertia" ? failingSources : [])] : [finitePythonSource(seed, "finite.refraction.python-order"), finitePythonSource(seed, "finite.refraction.python-sign")];
          assert.ok(allowed.includes(run.sourceText));
          assert.equal(run.sourceDigest, P.sha256Digest(run.sourceText));
          const rerun = executeTrusted(allowed.find(text => text === run.sourceText), executable, failingSources.includes(run.sourceText) ? 9 : 0);
          assert.equal(run.exitCode, rerun.exitCode); assert.equal(run.stdout, rerun.stdout); assert.equal(run.stderr, rerun.stderr);
        }
      }
      for (const action of trial.trace) {
        let observation = await artifact(action.observationDigest);
        if (observation.protocol === "jevyr.metabolic-lineage-observation/1") {
          assert.equal(observation.audit.lineageId, action.lane);
          assert.deepEqual(observation.audit.visibleCandidateIds, []);
          observation = await artifact(observation.generatorObservationDigest);
        }
        assert.equal(observation.protocol, "jevyr.metabolic-generator-observation/1");
        assert.equal(action.origin, observation.origin); assert.equal(action.family, observation.experiment);
        assert.equal(action.id, `call:${observation.seed}`);
        const permittedSources = kind === "Inertia" && observation.origin === "baseline" ? [finiteFailingScentSource(seed, 1), finiteFailingScentSource(seed, 2)] : [observation.experiment === "finite.baseline.node" ? finiteOracleSource(seed) : finitePythonSource(seed, observation.experiment)];
        assert.ok(permittedSources.includes(observation.source));
        assert.equal(observation.contribution.candidateBlueprintSource.files[0].content, observation.source);
        assert.equal(action.metric, action.origin === "baseline" ? "baseline" : P.METABOLIC_WORK_FOR_KIND[kind]);
        if (action.origin === "Fission") { assert.deepEqual(observation.visibleCandidateIds, []); assert.ok(observation.constraints.some(text => text.includes("Nursery phase EXILE"))); }
        if (action.origin === "Polarity") { assert.equal(observation.role, "challenger"); assert.ok(observation.visibleCandidateIds.length > 0); }
        if (action.origin === "Inertia") {
          assert.ok(observation.visibleCandidateIds.length > 0); assert.equal(observation.role, "reflex"); assert.ok(observation.revision);
          const decision = observation.inertiaDecision, receipt = observation.inertiaReceipt;
          const criticalIds = C.compileIntentContract({ impulse: "Success means `node experiment.mjs` exits with code 0." }).criticalObligations.map(value => value.id);
          R.assertInertiaContinuationDecision(decision, receipt, decision.history, criticalIds, []);
          assert.deepEqual(receipt, expectedReceipt, "Inertia receipt must bind the exact independently reconstructed trial and unit resources");
          assert.equal(receipt.quantity, trial.dose); assert.ok(decision.selected.every(value => observation.visibleCandidateIds.includes(value.candidateId)));
          const measuredByDigest = new Map();
          for (const item of decision.history) {
            assert.ok(trial.observationArtifactDigests.includes(item.observationDigest));
            const execution = await artifact(item.observationDigest);
            assert.equal(execution.protocol, "jevyr.metabolic-scent-execution/1"); assert.equal(execution.candidateId, item.candidateId);
            assert.equal(execution.assayId, item.assayId); assert.equal(execution.obligationId, item.obligationId); assert.equal(execution.costUnits, item.costUnits);
            assert.equal(execution.expectedExitCode, 0); assert.equal(item.status, "FAILED"); assert.equal(item.decisive, true);
            assert.ok([finiteFailingScentSource(seed, 1), finiteFailingScentSource(seed, 2)].includes(execution.sourceText));
            assert.equal(execution.sourceDigest, P.sha256Digest(execution.sourceText));
            const executedParent = baseline.hypotheses.find(value => value.id === item.candidateId);
            assert.ok(executedParent, "Failed probe names no independently admitted baseline parent");
            assert.equal(execution.sourceText, executedParent.candidateBlueprintSource.files[0].content, "Failed probe source must exactly equal its own admitted parent's source");
            const actual = executeTrusted(execution.sourceText, "node", 9);
            assert.equal(execution.exitCode, actual.exitCode); assert.equal(execution.stdout, actual.stdout); assert.equal(execution.stderr, actual.stderr);
            measuredByDigest.set(item.observationDigest, execution);
          }
          const context = observation.revisionContext, base = observation.revisionBase, parents = observation.revisionParentSources;
          assert.deepEqual(base.sealed, sealed);
          assert.deepEqual(base.publicFacts, baseline.hypotheses, "Revision public facts must be the independently admitted baseline population");
          assert.deepEqual(base.experimentCapability, experimentCapability);
          const expectedUnit = Object.fromEntries(Object.entries(expectedReceipt.grant).map(([key, value]) => [key, Math.floor(value / trial.dose)]));
          assert.deepEqual(context.resourceCeiling, expectedUnit);
          assert.equal(base.maxInputTokens, expectedUnit.maxInputTokens); assert.equal(base.maxOutputTokens, expectedUnit.maxOutputTokens);
          assert.equal(base.seed, R.investigationSeed(sealed, "mind", ["reflex", 0, new R.RuleMindAdapter().capability.id]));
          assert.equal(context.receiptDigest, receipt.digest); assert.equal(context.receiptSequence, receipt.sequence); assert.equal(context.round, 1);
          assert.equal(context.inputs.length, decision.history.length);
          for (const input of context.inputs) {
            const measured = measuredByDigest.get(input.observationDigest); assert.ok(measured);
            assert.equal(input.candidateId, measured.candidateId); assert.equal(input.assayId, measured.assayId); assert.equal(input.costUnits, measured.costUnits); assert.equal(input.admissible, true);
            assert.equal(input.evaluation.obligationId, measured.obligationId); assert.equal(input.evaluation.status, "FAILED"); assert.equal(input.evaluation.decisive, true);
            assert.equal(input.observation.oracle.execution.mode, "trusted-host"); assert.equal(input.observation.oracle.execution.state, "exited"); assert.equal(input.observation.oracle.execution.exitCode, measured.exitCode); assert.equal(input.observation.oracle.execution.stdout, measured.stdout); assert.equal(input.observation.oracle.execution.stderr, measured.stderr);
          }
          assert.deepEqual(context.feedback, R.executionFeedback(context.inputs)); assert.deepEqual(await artifact(context.feedbackArtifactDigest), context.feedback);
          assert.equal(base.sealed.caseDigest, report.suiteDigest); assert.equal(base.sealed.intent.seed, trial.seed); assert.equal(base.sealed.runDigest, hash({ suiteDigest: report.suiteDigest, seed: trial.seed }));
          assert.deepEqual(base.sealed.intentContract.criticalObligations.map(value => value.id), criticalIds);
          assert.equal(parents.length, 1); assert.deepEqual(context.parentCandidateIds, [parents[0].candidateId]);
          assert.ok(decision.selected.some(value => value.candidateId === parents[0].candidateId));
          const publicParent = base.publicFacts.find(value => value.id === parents[0].candidateId); assert.ok(publicParent);
          assert.ok([finiteFailingScentSource(seed, 1), finiteFailingScentSource(seed, 2)].includes(publicParent.candidateBlueprintSource.files[0].content));
          const compiledParent = R.compileCandidateBlueprint(publicParent.candidateBlueprintSource, R.compileJevyrIgnorePolicy(root, Buffer.from("")));
          assert.equal(compiledParent.blueprintDigest, parents[0].blueprintDigest); assert.deepEqual(compiledParent.files, parents[0].files);
          const rebuilt = R.buildExecutionRevisionRequest({ ...base, signal: new AbortController().signal }, context, parents, "none");
          assert.equal(rebuilt.seed, observation.seed); assert.deepEqual(rebuilt.revision, observation.revision); assert.deepEqual(rebuilt.constraints, observation.constraints);
          const prompt = Prompt.makePublicMindPrompt(rebuilt); assert.equal(P.sha256Digest(prompt), observation.promptDigest);
          const checked = await R.invokeExecutionRevision({ capability: new R.RuleMindAdapter().capability, async probe() { throw new Error("Not used"); }, async *run() { yield observation.contribution; } }, { ...rebuilt, preparedPublicPrompt: prompt });
          assert.equal(checked.admissionProblem, undefined); assert.equal(checked.result.contributions.length, 1); assert.deepEqual(checked.result.contributions[0].parentIds, context.parentCandidateIds);
          const { signal: _signal, ...capturedRebuilt } = { ...rebuilt, preparedPublicPrompt: prompt };
          assert.deepEqual(observation.request, capturedRebuilt);
          meteredUse.maxMindInvocations++; meteredUse.maxInputTokens += checked.result.tokenUsage.input.tokens; meteredUse.maxOutputTokens += checked.result.tokenUsage.output.tokens; meteredUse.maxGeneratedBytes += checked.result.receivedOutputBytes;
          replayIndex++;
        }
      }
      assert.equal(replayIndex, trial.trace.length, "Every recorded provider call must be independently replayed");
      assert.ok(localMeters.length >= 1, "Retained local monotonic-clock meter is required");
      const exactMeter = localMeters.find(meter => hash(meter.addedResourceUse) === hash(trial.addedResourceUse));
      assert.ok(exactMeter, "Claimed resource use differs from every retained local meter");
      for (const meter of localMeters) {
        assert.equal(meter.kind, kind); assert.equal(meter.seed, trial.seed); assert.equal(meter.dose, trial.dose);
        assert.equal(meter.traceDigest, hash(trial.trace));
        assert.equal(meter.wallMeasurement, "UNSIGNED_LOCAL_MONOTONIC_CLOCK");
        assert.equal(meter.wallAuthority, "retained bounded host measurement; not independently reproducible or remotely attested");
        P.assertMetabolicResourceVector(meter.addedResourceUse);
        const wall = meter.addedResourceUse.maxWallMillis;
        assert.ok(Number.isSafeInteger(wall) && (trial.dose === 0 ? wall === 0 : wall > 0 && wall <= expectedReceipt.grant.maxWallMillis));
        assert.deepEqual({ ...meter.addedResourceUse, maxWallMillis: 0 }, meteredUse, "Retained resource use differs from exact scheduler/admission reconstruction");
      }
      assert.deepEqual({ ...trial.addedResourceUse, maxWallMillis: 0 }, meteredUse, "Claimed resource use differs from exact scheduler/admission reconstruction");
      const fixed = await artifact(trial.identicalEvidence.evidenceDigest);
      assert.equal(fixed.checkerDigest, C.FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST);
      assert.equal(C.verifyFormalCounterexample(fixed.certificate, fixed.contract), true);
      const verdict = C.compileVerdict(C.projectEvents(fixed.events, { intentContract: fixed.contract, formalProofKernelDigest: fixed.checkerDigest }).input);
      assert.equal(hash(verdict), trial.identicalEvidence.baselineVerdictDigest);
      assert.equal(hash(verdict), trial.identicalEvidence.doseVerdictDigest);
    }
    verified.push({ kind, digest: report.digest, summary: calibration?.summary ?? null });
  }
  return { protocol: "jevyr.metabolic-experiment-verification/1", valid: options.diagnostic !== true && diagnosticProblems.length === 0, diagnostic: options.diagnostic === true, problems: diagnosticProblems, directory: root, reports: verified, independentlyExecutedTrustedSources: executions.size, verifiedArtifacts: cache.size, signatureStatus: "unsigned-local-experiment", resourceVerification: { providerCalls: "independently-replayed", inputAndOutputTokens: "exact-conservative-UTF8-upper-bounds", generatedBytes: "independently-reconstructed", wallMillis: "bounded-retained-unsigned-local-clock-not-independent-attestation" }, scope: "Finite deterministic fixtures and explicit presealed template diversity; not general live-model efficacy, causal family independence, or unseen-defect recall." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyMetabolicExperiment(process.argv[2], { development: process.argv.includes("--development"), diagnostic: process.argv.includes("--diagnostic") });
  await writeFile(join(result.directory, result.diagnostic ? "diagnostic-verification.json" : "independent-verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ valid: result.valid, directory: result.directory, independentlyExecutedTrustedSources: result.independentlyExecutedTrustedSources, verifiedArtifacts: result.verifiedArtifacts }));
}
