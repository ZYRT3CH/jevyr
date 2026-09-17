import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { verifyMetabolicExperiment } from "./verify-metabolic-calibration.mjs";
import { finiteFailingScentSource } from "./metabolic-fixtures.mjs";

test("independent calibration rejects rehashed resource, parent-source and foreign-receipt substitutions", async () => {
  const development = process.execArgv.includes("--conditions=development");
  const source = development ? "src" : "dist";
  const P = await import(`../packages/protocol/${source}/index.js`);
  const R = await import(`../packages/runtime/${source}/index.js`);
  const directory = await mkdtemp(join(tmpdir(), "jevyr-metabolic-binding-"));
  const produced = spawnSync(process.execPath, ["apps/cli/node_modules/tsx/dist/cli.mjs", ...(development ? ["--conditions=development"] : []), "scripts/calibrate-metabolism.ts", ...(development ? ["--development"] : []), "--seeds", "1", "--output", directory], { cwd: resolve("."), encoding: "utf8", windowsHide: true, timeout: 90_000 });
  assert.equal(produced.status, 1, produced.stderr); // One seed is deliberately insufficient.
  assert.match(produced.stdout, /Calibration needs at least 64 complete paired seeds/u);
  const verify = () => verifyMetabolicExperiment(directory, { development, diagnostic: true });
  assert.equal((await verify()).valid, false);
  const artifactPath = digest => join(directory, "artifacts", `${digest.slice(7)}.json`);
  const read = async digest => JSON.parse(await readFile(artifactPath(digest), "utf8"));
  const save = async value => { const digest = P.digestJson(value); await writeFile(artifactPath(digest), P.canonicalize(value)); return digest; };
  const rehash = value => { const { digest: _digest, ...body } = value; value.digest = P.digestJson(body); };
  const originalMass = await readFile(join(directory, "Mass.json"), "utf8");
  const mass = JSON.parse(originalMass);
  for (const trial of mass.trials.filter(trial => trial.dose > 0)) {
    for (const key of P.METABOLIC_RESOURCE_KEYS) trial.addedResourceUse[key] = 0;
    for (const [index, digest] of trial.observationArtifactDigests.entries()) {
      const row = await read(digest);
      if (row.protocol !== "jevyr.metabolic-local-meter/1") continue;
      row.addedResourceUse = { ...trial.addedResourceUse, maxWallMillis: 1 };
      trial.observationArtifactDigests[index] = await save(row);
    }
    trial.addedResourceUse.maxWallMillis = 1;
  }
  rehash(mass); await writeFile(join(directory, "Mass.json"), P.canonicalize(mass));
  await assert.rejects(verify, /exact scheduler\/admission reconstruction/u);
  await writeFile(join(directory, "Mass.json"), originalMass);

  const originalInertia = await readFile(join(directory, "Inertia.json"), "utf8");
  async function mutateInertia(mutate) {
    const report = JSON.parse(originalInertia);
    const trial = report.trials.find(trial => trial.dose === 1);
    const action = trial.trace.find(action => action.origin === "Inertia");
    const observation = await read(action.observationDigest);
    await mutate(observation, trial);
    action.observationDigest = await save(observation);
    trial.replicationTraceDigest = P.digestJson(trial.trace);
    rehash(report); await writeFile(join(directory, "Inertia.json"), P.canonicalize(report));
  }
  await mutateInertia(async (observation, trial) => {
    const decision = observation.inertiaDecision;
    const item = decision.history.find(row => row.candidateId === decision.selected[0].candidateId);
    const execution = await read(item.observationDigest);
    execution.sourceText = execution.sourceText === finiteFailingScentSource(0, 1) ? finiteFailingScentSource(0, 2) : finiteFailingScentSource(0, 1);
    execution.sourceDigest = P.sha256Digest(execution.sourceText);
    const changed = await save(execution);
    trial.observationArtifactDigests.push(changed);
    const history = decision.history.map(row => row === item ? { ...row, observationDigest: changed } : row);
    observation.inertiaDecision = R.planInertiaContinuation(observation.inertiaReceipt, history, decision.criticalObligationIds);
  });
  await assert.rejects(verify, /own admitted parent's source/u);
  await writeFile(join(directory, "Inertia.json"), originalInertia);
  await mutateInertia(async observation => {
    observation.inertiaReceipt.runDigest = `sha256:${"f".repeat(64)}`;
    rehash(observation.inertiaReceipt);
    observation.inertiaDecision = R.planInertiaContinuation(observation.inertiaReceipt, observation.inertiaDecision.history, observation.inertiaDecision.criticalObligationIds);
  });
  await assert.rejects(verify, /exact independently reconstructed trial/u);
  await writeFile(join(directory, "Inertia.json"), originalInertia);
  assert.equal((await verify()).valid, false);
});
