#!/usr/bin/env node
import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { qualificationDigest, qualificationHash } from "./live-model-fixtures.mjs";
import { assertQualificationManifest, verifyLiveModelQualification } from "./verify-live-model-qualification.mjs";
import { BLIND_ARM_DIRECTORY, BLIND_ARM_PROTOCOL, BLIND_ARM_RUNNER_ARCHIVE, BLIND_MAX_TOKENS, BLIND_TEMPERATURE, HARDENING_FLAGS, aggregateBlindTrials, blindDriverSource, blindSeedInteger, blindSourcePrompt, compareBlindObservation, corpusPairs, withSourceProbeVectors } from "./blind-source-arm.mjs";

async function bytes(path, limit = 16 * 1024 * 1024) {
  const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= limit);
  const value = await readFile(path); assert.equal(value.length, before.size); return value;
}
const json = async path => JSON.parse((await bytes(path)).toString("utf8"));

/** Independent recalculation from retained files; nothing is rerun and the archived runner bytes are never imported. */
export async function verifyBlindSourceArm(directory, options = {}) {
  const root = resolve(directory), armRoot = join(root, BLIND_ARM_DIRECTORY);
  const manifest = assertQualificationManifest(await json(join(root, "manifest.json"))), report = await json(join(armRoot, "report.json"));
  const { digest: reportDigest, ...body } = report; assert.equal(qualificationDigest(body), reportDigest, "blind arm report digest mismatch");
  assert.equal(report.protocol, BLIND_ARM_PROTOCOL); assert.equal(report.manifestDigest, manifest.digest, "blind arm belongs to another manifest");
  assert.equal(qualificationHash(await bytes(join(armRoot, BLIND_ARM_RUNNER_ARCHIVE))), report.runnerDigest, "Retained blind-arm runner differs from its declared identity");
  assert.equal(report.dockerImage, manifest.config.dockerImage); assert.match(report.imageId, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(report.sampling, { temperature: BLIND_TEMPERATURE, maxTokens: BLIND_MAX_TOKENS, seedDerivation: "uint32 from the first eight hex digits of the configured seed", seedEnforcement: "UNVERIFIED" });
  const pairs = corpusPairs(manifest.corpus), expected = [];
  for (const provider of manifest.config.providers) for (const seed of manifest.config.seeds) for (const pair of pairs) expected.push({ providerId: provider.id, seed, pairKey: pair.pairKey });
  assert.equal(report.trials.length, expected.length, "The predeclared blind generation denominator changed"); assert.equal(report.planned, expected.length); assert.equal(report.complete, true);
  const verification = await verifyLiveModelQualification(root, { development: options.development === true }), vectors = await withSourceProbeVectors(root, manifest, verification);
  const recomputed = [];
  for (const [index, trial] of report.trials.entries()) {
    assert.deepEqual({ providerId: trial.providerId, seed: trial.seed, pairKey: trial.pairKey }, expected[index]);
    const provider = manifest.config.providers.find(entry => entry.id === trial.providerId), pair = pairs.find(entry => entry.pairKey === trial.pairKey);
    const trialDirectory = resolve(armRoot, trial.directory), inside = relative(armRoot, trialDirectory); assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside), "Trial directory escapes the blind arm");
    const invocation = await json(join(trialDirectory, "invocation.json")), generation = await json(join(trialDirectory, "generation.json"));
    assert.equal(invocation.prompt, blindSourcePrompt(pair.spec)); assert.equal(qualificationHash(invocation.prompt), trial.promptDigest); assert.equal(invocation.promptDigest, trial.promptDigest);
    assert.ok(invocation.prompt.includes(pair.spec.intendedBehavior)); for (const content of pair.sourceFiles) assert.ok(!invocation.prompt.includes(content), "Blind prompt leaked fixture source or oracle text");
    assert.equal(invocation.request.model, provider.model); assert.equal(trial.model, provider.model); assert.equal(invocation.request.temperature, BLIND_TEMPERATURE); assert.equal(invocation.request.seed, blindSeedInteger(trial.seed));
    assert.equal(invocation.request.max_tokens, BLIND_MAX_TOKENS); assert.deepEqual(invocation.request.messages, [{ role: "user", content: invocation.prompt }]); assert.equal(invocation.specDigest, pair.specDigest);
    assert.equal(trial.generated, generation.source !== null);
    let execution = null;
    if (generation.source !== null) {
      const observation = await json(join(trialDirectory, "observation.json"));
      assert.equal(qualificationHash(await bytes(join(trialDirectory, "candidate", "solution.mjs"))), qualificationHash(generation.source));
      assert.equal((await bytes(join(trialDirectory, "candidate", "program.mjs"))).toString("utf8"), blindDriverSource(pair.functionName));
      for (const flag of HARDENING_FLAGS) assert.ok(observation.command.includes(flag), `Missing hardening flag ${flag}`);
      assert.deepEqual(observation.command.slice(-4), ["--entrypoint", "node", report.imageId, "/candidate/program.mjs"]); assert.equal(observation.imageId, report.imageId);
      if (observation.execution) { assert.equal(observation.sourceUnchanged, true); assert.equal(observation.driverDigest, qualificationHash(blindDriverSource(pair.functionName))); execution = observation.execution; }
    }
    const withSourceProbes = manifest.planned.filter(entry => entry.providerId === trial.providerId && entry.seed === trial.seed && pair.cases.some(member => member.caseKey === entry.caseKey)).flatMap(entry => vectors.get(entry.attemptId) ?? []);
    const comparison = compareBlindObservation(execution, pair, withSourceProbes);
    assert.deepEqual(trial.comparison, comparison, `Recorded comparison differs for ${trial.pairKey}`); assert.equal(trial.executed, comparison.blindExecuted);
    recomputed.push({ ...trial, comparison });
  }
  const aggregate = aggregateBlindTrials(recomputed);
  assert.deepEqual({ planned: report.planned, generated: report.generated, executed: report.executed, blindEqualsIntended: report.blindEqualsIntended, defective: report.defective, clean: report.clean }, aggregate, "Aggregate counts differ from the retained trials");
  return { protocol: "jevyr.verified-blind-source-arm/1", scope: "independent-recalculation-from-retained-trials-and-authenticated-probe-artifacts", authenticity: "UNSIGNED_LOCAL_EXPERIMENT", reportDigest, manifestDigest: manifest.digest, trials: report.trials.length, aggregate,
    caveat: "Equality between a blind implementation and a with-source probe shows the probe reproduced the model's spec-derived belief; it does not measure model quality, and no verdict authority is derived." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyBlindSourceArm(process.argv[2], { development: process.argv.includes("--development") });
  await writeFile(join(resolve(process.argv[2]), BLIND_ARM_DIRECTORY, "verified.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" }); console.log(JSON.stringify(result));
}
