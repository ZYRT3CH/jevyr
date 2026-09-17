import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import {
  candidateExperimentReadiness,
  compileAssayFrontier,
  compileCandidateBlueprint,
  compileExperimentCapability,
  DEFAULT_SEARCH_PROFILE,
  evaluateComparativeExperiment,
  loadJevyrIgnorePolicy,
} from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function frontier(obligationId?: string) {
  return compileAssayFrontier([{
    assayId: "jevyr.experiment.node-v1",
    costUnits: 1,
    tool: "forge.command",
    args: { command: "node", args: ["jevyr.experiment.mjs"] },
    timeoutMs: 30_000,
    ...(obligationId === undefined ? {} : { obligationId }),
  }], DEFAULT_SEARCH_PROFILE.resources);
}

test("a narrow unbound experiment socket is comparative-only and candidate readiness is exact", async () => {
  const contract = compileIntentContract({ impulse: "Create an unfamiliar but finite mechanism." });
  const capability = compileExperimentCapability(frontier(), contract);
  assert.equal(capability.protocol, "jevyr.experiment-capability/1");
  assert.equal(capability.experiments.length, 1);
  assert.deepEqual(capability.experiments[0], {
    assayId: "jevyr.experiment.node-v1",
    costUnits: 1,
    timeoutMs: 30_000,
    tool: "forge.command",
    command: { executable: "node", args: ["jevyr.experiment.mjs"], shell: false },
    entryFile: "jevyr.experiment.mjs",
    authority: "comparative-only",
  });

  const root = await mkdtemp(join(tmpdir(), "jevyr-experiment-capability-"));
  temporary.push(root);
  const policy = await loadJevyrIgnorePolicy(root);
  const ready = compileCandidateBlueprint({
    protocol: "jevyr.candidate-blueprint/1",
    files: [{ path: "jevyr.experiment.mjs", content: "process.exit(0);\n" }],
    command: { executable: "node", args: ["jevyr.experiment.mjs"] },
  }, policy);
  assert.deepEqual(candidateExperimentReadiness(ready, capability), {
    ready: true,
    experimentIds: ["jevyr.experiment.node-v1"],
    problems: [],
  });

  const mismatch = compileCandidateBlueprint({
    protocol: "jevyr.candidate-blueprint/1",
    files: [{ path: "jevyr.experiment.mjs", content: "process.exit(0);\n" }],
    command: { executable: "node", args: ["another.mjs"] },
  }, policy);
  assert.deepEqual(candidateExperimentReadiness(mismatch, capability).problems, ["command-not-sealed"]);
});

test("only the fixed entrypoint grammar is exposed and explicit invalid obligation bindings fail closed", () => {
  const contract = compileIntentContract({ impulse: "Create an artifact." });
  const unsafe = compileAssayFrontier([
    {
      assayId: "shell-like",
      costUnits: 1,
      tool: "forge.command",
      args: { command: "sh", args: ["-c", "anything"] },
    },
    {
      assayId: "extra-node-argument",
      costUnits: 1,
      tool: "forge.command",
      args: { command: "node", args: ["experiment.mjs", "--weaken"] },
    },
    {
      assayId: "forged-obligation",
      costUnits: 1,
      tool: "forge.command",
      args: { command: "node", args: ["experiment.mjs"] },
      obligationId: `obl_${"0".repeat(20)}`,
    },
  ], DEFAULT_SEARCH_PROFILE.resources);
  assert.deepEqual(compileExperimentCapability(unsafe, contract).experiments, []);
});

test("an exact command obligation upgrades the socket while comparative evaluation never creates an Intent edge", () => {
  const contract = compileIntentContract({ impulse: "`node jevyr.experiment.mjs` exits with code 0" });
  const capability = compileExperimentCapability(frontier(), contract);
  const experiment = capability.experiments[0];
  assert.equal(experiment?.authority, "intent-bound");
  assert.match(experiment?.obligationId ?? "", /^obl_[a-f0-9]{20}$/u);

  const comparativeContract = compileIntentContract({ impulse: "Create a finite mechanism." });
  const comparative = compileExperimentCapability(frontier(), comparativeContract).experiments[0];
  assert.ok(comparative);
  const evaluation = evaluateComparativeExperiment(comparative, {
    execution: {
      state: "exited",
      mode: "docker",
      command: "node",
      args: ["jevyr.experiment.mjs"],
      shell: false,
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputTruncated: false,
    },
  });
  assert.equal(evaluation.status, "PASSED");
  assert.equal(evaluation.decisive, true);
  assert.equal(evaluation.oracleKind, undefined);
  assert.match(evaluation.reason, /does not satisfy an Intent obligation/u);
});
