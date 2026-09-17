#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validateQualificationConfig, qualificationDigest, qualificationHash } from "../benchmarks/live-model-fixtures.mjs";
import { corpusForConfig, GENERATED_CORPUS_PROTOCOL } from "../benchmarks/generated-source-fixtures.mjs";

/** Versioned cohort driver: predeclares the denominator, runs the compiled-dist runner, then every read-only measurement. Nothing is retried or deleted. */
const repository = resolve(import.meta.dirname, ".."), artifacts = join(repository, "artifacts");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!["--config", "--output"].includes(key) || args.has(key)) throw new Error("Use --config FILE --output NEW_DIRECTORY; unknown or duplicate options are refused");
  const value = process.argv[++index]; if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`); args.set(key, value);
}
assert.ok(args.has("--config") && args.has("--output"), "--config and --output are required");
const configPath = resolve(args.get("--config")), configBytes = await readFile(configPath); assert.ok(configBytes.length <= 65_536);
const config = validateQualificationConfig(JSON.parse(configBytes.toString("utf8")));
assert.equal(config.corpus?.kind, "generated", "This driver runs generated corpora; use scripts/live-model-qualification.ts directly for the fixed baseline");
const root = resolve(args.get("--output")), part = relative(artifacts, root);
assert.ok(part && !part.startsWith("..") && !isAbsolute(part), "Output must be a fresh directory within repository artifacts");
const dispatchRoot = `${root}-dispatch`;
for (const path of [root, dispatchRoot]) await access(path).then(() => { throw new Error(`${path} already exists; a cohort root is never reused`); }, () => {});
await mkdir(dispatchRoot, { recursive: true });
const corpus = corpusForConfig(config);
const sourceDigests = {};
for (const file of ["scripts/live-model-qualification.ts", "benchmarks/live-model-fixtures.mjs", "benchmarks/generated-source-fixtures.mjs", "benchmarks/verify-live-model-qualification.mjs", "benchmarks/probe-recovery-measurement.mjs", "benchmarks/blind-source-arm.mjs", "benchmarks/verify-blind-source-arm.mjs", "benchmarks/prior-override-measurement.mjs", "scripts/summarize-live-model-qualification.mjs"]) sourceDigests[file] = qualificationHash(await readFile(join(repository, file)));
const dispatchConfig = join(dispatchRoot, "config.json"); await writeFile(dispatchConfig, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
const plannedAttempts = config.providers.length * config.seeds.length * config.repeats * corpus.cases.length, plannedBlindGenerations = config.providers.length * config.seeds.length * config.corpus.taskPairs;
const dispatchBody = { protocol: "jevyr.declared-cohort-dispatch/1", declaredAt: new Date().toISOString(), root, dispatchRoot, configPath, configurationDigest: qualificationDigest(config), corpusDigest: corpus.digest, generatorProtocol: GENERATED_CORPUS_PROTOCOL,
  plannedAttempts, plannedBlindGenerations, sourceDigests, inferenceAuthorized: true, retries: 0, profileChanges: [] };
await writeFile(join(dispatchRoot, "dispatch.json"), JSON.stringify({ ...dispatchBody, digest: qualificationDigest(dispatchBody) }, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ phase: "dispatch", root, plannedAttempts, plannedBlindGenerations, corpusDigest: corpus.digest }));

const steps = [];
async function step(name, argv, { required = false } = {}) {
  const startedAt = new Date().toISOString(), log = createWriteStream(join(dispatchRoot, `${name}.log`), { flags: "wx" });
  const child = spawn(process.execPath, argv, { cwd: repository, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "", NODE_USE_ENV_PROXY: "0" } });
  child.stdout.on("data", chunk => { log.write(chunk); process.stdout.write(chunk); }); child.stderr.on("data", chunk => { log.write(chunk); process.stderr.write(chunk); });
  const outcome = await new Promise((resolveStep, reject) => { child.once("error", reject); child.once("close", (exitCode, signal) => resolveStep({ exitCode, signal })); });
  await new Promise(resolveLog => log.end(resolveLog));
  steps.push({ name, argv, startedAt, finishedAt: new Date().toISOString(), ...outcome });
  await writeFile(join(dispatchRoot, "steps.json"), JSON.stringify({ protocol: "jevyr.cohort-dispatch-steps/1", root, steps }, null, 2) + "\n");
  console.log(JSON.stringify({ phase: "step", name, exitCode: outcome.exitCode, signal: outcome.signal }));
  if (required && outcome.exitCode !== 0) throw new Error(`${name} failed with exit ${outcome.exitCode}`);
  return outcome;
}
const runner = await step("runner", ["--import", "./apps/cli/node_modules/tsx/dist/loader.mjs", "scripts/live-model-qualification.ts", "--config", dispatchConfig, "--output", root, "--measure-recovery", "--execute"]);
const manifestPresent = await access(join(root, "manifest.json")).then(() => true, () => false);
if (manifestPresent) {
  await step("recovery", ["benchmarks/probe-recovery-measurement.mjs", root]);
  await step("independent-verification", ["benchmarks/verify-live-model-qualification.mjs", root]);
  await step("blind-arm", ["benchmarks/blind-source-arm.mjs", root]);
  await step("verify-blind-arm", ["benchmarks/verify-blind-source-arm.mjs", root]);
  await step("summary", ["scripts/summarize-live-model-qualification.mjs", root]);
}
const summary = await readFile(join(root, "summary.json"), "utf8").then(JSON.parse, () => null);
console.log(JSON.stringify({ phase: "done", root, runnerExit: runner.exitCode, planned: summary?.planned ?? plannedAttempts, qualified: summary?.qualified ?? null, priorOverrideRateByProbe: summary?.priorOverride?.priorOverrideRateByProbe ?? null,
  blindGenerated: summary?.blindArm?.generated ?? null, steps: steps.map(entry => `${entry.name}=${entry.exitCode}`).join(" "), next: `inspect ${relative(repository, root).split("\\").join("/")}/summary.json and ${relative(repository, dispatchRoot).split("\\").join("/")}/steps.json` }));
process.exitCode = runner.exitCode ?? 1;
