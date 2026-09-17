#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const has = (name) => args.includes(name);
const corpusPath = resolve(value("--corpus", "benchmarks/corpus.v1.json"));
const mechanismPath = resolve(value("--mechanisms", "benchmarks/mechanisms.v1.json"));
const baseUrl = value("--url", process.env.JEVYR_URL ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const mechanisms = JSON.parse(await readFile(mechanismPath, "utf8"));

if (corpus.protocol !== "jevyr.benchmark-corpus/1" || !Array.isArray(corpus.cases) || corpus.cases.length === 0) {
  throw new Error("Invalid Jevyr benchmark corpus");
}
const seen = new Set();
for (const entry of corpus.cases) {
  if (!entry.id || seen.has(entry.id) || !entry.impulse?.trim()) throw new Error(`Invalid benchmark entry ${entry.id ?? "<missing>"}`);
  if (!entry.expect?.creation || !entry.expect?.judgment) throw new Error(`${entry.id} must assert creation and judgment`);
  seen.add(entry.id);
}
if (mechanisms.protocol !== "jevyr.mechanism-intake-set/1" || !Array.isArray(mechanisms.records)) {
  throw new Error("Invalid Jevyr mechanism-intake set");
}
for (const record of mechanisms.records) {
  if (
    record.protocol !== "jevyr.mechanism-intake/1" ||
    !record.id ||
    !record.source?.uri ||
    !["not_run", "passed", "failed", "inconclusive"].includes(record.reproduction?.status) ||
    !["ADOPTED", "EXPERIMENTAL", "REJECTED"].includes(record.status)
  ) throw new Error(`Invalid mechanism-intake record ${record.id ?? "<missing>"}`);
  if (
    record.status === "ADOPTED" &&
    (record.reproduction.status !== "passed" || !record.reproduction.evidenceDigests?.length || !record.benchmark?.resultDigests?.length)
  ) throw new Error(`${record.id} cannot be ADOPTED without reproduced and benchmarked evidence`);
}
// All execution flows through the SDK's authenticated observer and independent
// persisted-evidence replay. The former raw HTTP verdict-only runner is removed.
const cliArguments = ["apps/cli/node_modules/tsx/dist/cli.mjs", ...(has("--development") ? ["--conditions=development"] : []), "apps/cli/src/main.ts", "benchmark", "--corpus", corpusPath, "--url", baseUrl];
if (has("--validate-only")) cliArguments.push("--validate-only");
if (has("--json")) cliArguments.push("--json");
if (has("--report")) cliArguments.push("--report", resolve(value("--report")));
const child = spawn(process.execPath, cliArguments, { stdio: "inherit", windowsHide: true });
child.once("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once("close", (code) => { process.exitCode = code ?? 1; });
