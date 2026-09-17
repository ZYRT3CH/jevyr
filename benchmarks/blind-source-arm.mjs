#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PROBE_ASSAY_ID, qualificationDigest, qualificationHash } from "./live-model-fixtures.mjs";
import { assertQualificationManifest, verifyLiveModelQualification } from "./verify-live-model-qualification.mjs";

/** Spec-only generations under the same local provider, executed in the hardened blind-memory container pattern.
 *  Measures whether the with-source probe reproduces the model's own spec-derived belief; it has no verdict authority. */
export const BLIND_ARM_PROTOCOL = "jevyr.blind-source-arm-report/1";
export const BLIND_ARM_DIRECTORY = "blind-arm";
export const BLIND_ARM_RUNNER_ARCHIVE = "blind-arm-runner-source.mjs";
export const BLIND_TEMPERATURE = 0.8;
export const BLIND_MAX_TOKENS = 4096;
export const HARDENING_FLAGS = Object.freeze(["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=256m", "--cpus=1", "--pids-limit=64", "--user=65532:65532"]);
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
const sameVector = (left, right) => Array.isArray(left) && Array.isArray(right) && canonical(left) === canonical(right);

export const blindSeedInteger = seed => Number.parseInt(String(seed).slice(0, 8), 16);
export const chatCompletionsUrl = baseUrl => new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;

/** Pairs are discovered from the specification bytes: the clean and defective members of a task share one qualification.json. */
export function corpusPairs(corpus) {
  const pairs = new Map();
  for (const entry of corpus.cases) {
    const specification = entry.files.find(file => file.path === "qualification.json"); assert.ok(specification, `${entry.caseKey} lacks qualification.json`);
    const specDigest = qualificationHash(specification.content), spec = JSON.parse(specification.content);
    const pair = pairs.get(specDigest) ?? { pairKey: entry.pairKey ?? "clamp", specDigest, spec, functionName: spec.function.slice(0, spec.function.indexOf("(")),
      declaredInputs: spec.observations.map(row => row.input), intended: spec.observations.map(row => row.expected), sourceFiles: [], cases: [] };
    pair.cases.push({ caseKey: entry.caseKey, defective: entry.expectedJudgment === "REJECT", actual: entry.expectedObservation.rows.map(row => row.actual) });
    pair.sourceFiles.push(...entry.files.filter(file => file.path !== "qualification.json").map(file => file.content));
    pairs.set(specDigest, pair);
  }
  const list = [...pairs.values()];
  for (const pair of list) {
    assert.match(pair.functionName, /^[A-Za-z_$][A-Za-z0-9_$]*$/u);
    assert.equal(pair.cases.length, 2, `${pair.pairKey} must pair one clean and one defective case`); assert.equal(pair.cases.filter(entry => entry.defective).length, 1);
  }
  return list;
}

export function blindSourcePrompt(spec) {
  const examples = spec.observations.map(row => `${JSON.stringify(row.input)} -> ${JSON.stringify(row.expected)}`).join("\n");
  const name = spec.function.slice(0, spec.function.indexOf("("));
  return `You are given only a specification of one JavaScript function. No source file exists; implement the function yourself from the specification.\nFunction: ${spec.function}\nBehavior: ${spec.intendedBehavior}\nDeclared examples (argument list -> expected result):\n${examples}\nRespond with exactly one JSON object of the form {"source": "<ES module text>"}. The module must contain exactly one export, \`export function ${name}(...)\` with the declared parameter list, must not import anything, must not read stdin or print, and must contain no Markdown fences or commentary.`;
}
export const blindDriverSource = functionName => `import { ${functionName} } from "./solution.mjs";\nimport { readFileSync } from "node:fs";\nprocess.stdout.write(JSON.stringify(JSON.parse(readFileSync(0, "utf8")).map(input => ${functionName}(...input))));\n`;

/** Pure comparison; `execution` is the recorded container run or null, `withSourceProbes` the decoded probe vectors of the pair's attempts. */
export function compareBlindObservation(execution, pair, withSourceProbes) {
  let blindVector = null;
  if (execution && execution.exitCode === 0 && !execution.timedOut && !execution.exceeded) {
    try { const parsed = JSON.parse(execution.stdout); if (Array.isArray(parsed) && parsed.length === pair.declaredInputs.length) blindVector = parsed; } catch { blindVector = null; }
  }
  const blindExecuted = blindVector !== null;
  const perCase = pair.cases.map(entry => ({ caseKey: entry.caseKey, defective: entry.defective, blindEqualsActual: blindExecuted ? sameVector(blindVector, entry.actual) : null }));
  const withSource = withSourceProbes.map(probe => ({ ...probe, probeEqualsIntended: probe.probeVector === null ? null : sameVector(probe.probeVector, pair.intended),
    blindEqualsWithSourceProbe: blindExecuted && probe.probeVector !== null ? sameVector(blindVector, probe.probeVector) : null }));
  const first = defective => withSource.find(probe => probe.defective === defective && probe.probeVector !== null);
  return { blindExecuted, blindVector, blindEqualsIntended: blindExecuted ? sameVector(blindVector, pair.intended) : null, perCase, withSource,
    blindEqualsFirstWithSourceProbe: { clean: first(false)?.blindEqualsWithSourceProbe ?? null, defective: first(true)?.blindEqualsWithSourceProbe ?? null } };
}

export function aggregateBlindTrials(trials) {
  const defective = { comparisons: 0, blindEqualsWithSourceProbe: 0, blindEqualsIntendedAndProbeMatchesIntended: 0, blindEqualsDefectActual: 0 }, clean = { comparisons: 0, blindEqualsWithSourceProbe: 0 };
  for (const trial of trials) {
    const comparison = trial.comparison; if (!comparison) continue;
    for (const probe of comparison.withSource) {
      const bucket = probe.defective ? defective : clean;
      if (probe.blindEqualsWithSourceProbe === null) continue;
      bucket.comparisons += 1; if (probe.blindEqualsWithSourceProbe) bucket.blindEqualsWithSourceProbe += 1;
      if (probe.defective && comparison.blindEqualsIntended && probe.probeEqualsIntended) defective.blindEqualsIntendedAndProbeMatchesIntended += 1;
    }
    if (comparison.perCase.some(entry => entry.defective && entry.blindEqualsActual === true)) defective.blindEqualsDefectActual += 1;
  }
  return { planned: trials.length, generated: trials.filter(trial => trial.generated).length, executed: trials.filter(trial => trial.comparison?.blindExecuted).length,
    blindEqualsIntended: trials.filter(trial => trial.comparison?.blindEqualsIntended === true).length, defective, clean };
}

const decodeStdout = execution => { const capture = execution.stdoutCapture; assert.equal(capture.complete, true); const raw = Buffer.from(capture.data, "base64"); assert.equal(qualificationHash(raw), capture.digest); return raw.toString("utf8"); };
/** Decodes every executed with-source probe of the cohort into actual-column vectors, keyed by attempt. Artifact bytes are digest-checked before use. */
export async function withSourceProbeVectors(root, manifest, verification) {
  const json = async path => JSON.parse(await readFile(path, "utf8")), vectors = new Map();
  for (const planned of manifest.planned) {
    const checked = verification.attempts.find(entry => entry.attemptId === planned.attemptId), fixture = manifest.corpus.cases.find(entry => entry.caseKey === planned.caseKey);
    const probes = [];
    if (checked?.checks?.fullReplay) {
      const proof = join(root, planned.directory, "proof"), index = await json(join(proof, "artifact-index.json"));
      for (const meta of index.artifacts.filter(entry => entry.mediaType === "application/vnd.jevyr.tool-observation+json")) {
        const raw = await readFile(join(proof, "artifacts", `${meta.id}.blob`)); assert.equal(qualificationHash(raw), meta.digest); assert.equal(raw.length, meta.size);
        const observation = JSON.parse(raw.toString("utf8")); if (observation.metadata?.assayId !== PROBE_ASSAY_ID) continue;
        const row = (checked.probeRows ?? []).find(entry => entry.artifactDigest === meta.digest), execution = observation.oracle?.execution;
        let probeVector = null;
        if (row?.executed && execution?.exitCode === 0) { try { const parsed = JSON.parse(decodeStdout(execution)); const rows = parsed?.rows; if (Array.isArray(rows) && rows.length === fixture.expectedObservation.rows.length && rows.every(entry => entry && typeof entry === "object" && Object.hasOwn(entry, "actual"))) probeVector = rows.map(entry => entry.actual); } catch { probeVector = null; } }
        probes.push({ attemptId: planned.attemptId, caseKey: planned.caseKey, repeat: planned.repeat, defective: fixture.expectedJudgment === "REJECT", candidateId: observation.metadata.candidateId, artifactDigest: meta.digest, executed: row?.executed ?? false, exitCode: execution?.exitCode ?? null, probeVector });
      }
    }
    vectors.set(planned.attemptId, probes);
  }
  return vectors;
}

async function command(executable, args, { input = "", timeoutMs = 30_000 } = {}) {
  return new Promise(resolveRun => {
    const started = Date.now(), child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), exceeded = false, timedOut = false;
    const collect = stream => bytes => { if (stdout.length + stderr.length + bytes.length > 1_048_576) { exceeded = true; child.kill(); return; } if (stream === "out") stdout = Buffer.concat([stdout, bytes]); else stderr = Buffer.concat([stderr, bytes]); };
    child.stdout.on("data", collect("out")); child.stderr.on("data", collect("err")); child.stdin.on("error", () => {});
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); resolveRun({ exitCode: null, stdout: "", stderr: error.message, wallMillis: Date.now() - started, exceeded, timedOut }); });
    child.once("close", exitCode => { clearTimeout(timer); resolveRun({ exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), wallMillis: Date.now() - started, exceeded, timedOut }); });
    child.stdin.end(input);
  });
}
async function requestModel(provider, prompt, seed) {
  const started = Date.now();
  const request = { model: provider.model, stream: false, temperature: BLIND_TEMPERATURE, seed: blindSeedInteger(seed), max_tokens: BLIND_MAX_TOKENS, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] };
  let response;
  try { response = await fetch(chatCompletionsUrl(provider.baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(180_000) }); }
  catch (error) { return { request, responseStatus: null, response: null, wallMillis: Date.now() - started, seedEnforcement: "UNVERIFIED", source: null, problem: `Transport failed: ${error.message}` }; }
  const reader = response.body.getReader(), chunks = []; let length = 0, problem = null;
  try { while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 1_048_576) { await reader.cancel(); problem = "Provider exceeded response bound"; break; } chunks.push(Buffer.from(item.value)); } } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks).toString("utf8"), result = { request, responseStatus: response.status, response: raw, wallMillis: Date.now() - started, seedEnforcement: "UNVERIFIED", source: null, problem };
  if (problem) return result;
  if (!response.ok) return { ...result, problem: `HTTP ${response.status}` };
  try {
    const object = JSON.parse(JSON.parse(raw).choices[0].message.content);
    if (!object || typeof object !== "object" || Object.keys(object).length !== 1 || typeof object.source !== "string" || Buffer.byteLength(object.source) > 65_536) throw new Error("Expected exactly one bounded source string");
    return { ...result, source: object.source };
  } catch (error) { return { ...result, problem: error.message }; }
}
async function execute(trialRoot, source, driver, inputs, imageId) {
  const candidate = join(trialRoot, "candidate"); await mkdir(candidate);
  await writeFile(join(candidate, "solution.mjs"), source, { flag: "wx" }); await writeFile(join(candidate, "program.mjs"), driver, { flag: "wx" });
  assert.ok(!candidate.includes(","), "Docker mount path may not contain a comma");
  const args = ["create", "-i", ...HARDENING_FLAGS, "--mount", `type=bind,source=${candidate},target=/candidate,readonly`, "--tmpfs", "/tmp:rw,noexec,nosuid,size=16777216", "--entrypoint", "node", imageId, "/candidate/program.mjs"];
  const created = await command("docker", args), containerId = created.stdout.trim();
  if (created.exitCode !== 0 || !/^[a-f0-9]{64}$/u.test(containerId)) return { command: args, imageId, containerId: null, execution: null, problem: "Container creation failed", created };
  try {
    const inspection = await command("docker", ["container", "inspect", "--format", "{{json .Image}}", containerId]);
    if (inspection.exitCode !== 0 || JSON.parse(inspection.stdout) !== imageId) return { command: args, imageId, containerId, execution: null, problem: "Concrete container did not bind the pinned image", inspection };
    const execution = await command("docker", ["start", "-ai", containerId], { input: JSON.stringify(inputs) });
    const sourceUnchanged = qualificationHash(await readFile(join(candidate, "solution.mjs"))) === qualificationHash(source) && qualificationHash(await readFile(join(candidate, "program.mjs"))) === qualificationHash(driver);
    return { command: args, imageId, containerId, execution, sourceDigest: qualificationHash(source), driverDigest: qualificationHash(driver), inputDigest: qualificationDigest(inputs), sourceUnchanged, problem: sourceUnchanged ? null : "Candidate bytes changed during execution" };
  } finally { await command("docker", ["rm", "--force", containerId]); }
}

export async function runBlindSourceArm(directory, options = {}) {
  const root = resolve(directory), json = async path => JSON.parse(await readFile(path, "utf8"));
  const manifest = assertQualificationManifest(await json(join(root, "manifest.json"))), verification = await verifyLiveModelQualification(root, { development: options.development === true });
  const vectors = await withSourceProbeVectors(root, manifest, verification), pairs = corpusPairs(manifest.corpus), armRoot = join(root, BLIND_ARM_DIRECTORY);
  const inspected = await command("docker", ["image", "inspect", "--format", "{{json .Id}}", manifest.config.dockerImage]);
  assert.equal(inspected.exitCode, 0, "Docker image is not available; no pull is attempted"); const imageId = JSON.parse(inspected.stdout.trim()); assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  await mkdir(armRoot);
  const runnerBytes = await readFile(new URL(import.meta.url)); await writeFile(join(armRoot, BLIND_ARM_RUNNER_ARCHIVE), runnerBytes, { flag: "wx" });
  const trials = [], planned = manifest.config.providers.length * manifest.config.seeds.length * pairs.length;
  const write = async () => {
    const body = { protocol: BLIND_ARM_PROTOCOL, manifestDigest: manifest.digest, runnerDigest: qualificationHash(runnerBytes), imageId, dockerImage: manifest.config.dockerImage,
      sampling: { temperature: BLIND_TEMPERATURE, maxTokens: BLIND_MAX_TOKENS, seedDerivation: "uint32 from the first eight hex digits of the configured seed", seedEnforcement: "UNVERIFIED" },
      promptIncludesDeclaredExamples: true, ...aggregateBlindTrials(trials), complete: trials.length === planned, trials,
      scope: "Direct spec-only generations under the same local provider with no source access, executed in a hardened disposable container. Measures whether the with-source probe reproduces the model's spec-derived belief; it establishes no model quality and holds no verdict authority.",
      denominator: "every planned generation, including malformed responses, transport failures and failed executions" };
    await writeFile(join(armRoot, "report.json"), JSON.stringify({ ...body, digest: qualificationDigest(body) }, null, 2) + "\n");
  };
  for (const provider of manifest.config.providers) for (const seed of manifest.config.seeds) for (const pair of pairs) {
    const trialDirectory = join(armRoot, provider.id, seed.slice(0, 12), pair.pairKey); await mkdir(trialDirectory, { recursive: true });
    const prompt = blindSourcePrompt(pair.spec), promptDigest = qualificationHash(prompt), startedAt = new Date().toISOString();
    console.log(JSON.stringify({ phase: "blind-started", providerId: provider.id, seed: seed.slice(0, 12), pairKey: pair.pairKey }));
    const generation = await requestModel(provider, prompt, seed);
    await writeFile(join(trialDirectory, "invocation.json"), JSON.stringify({ providerId: provider.id, model: provider.model, baseUrl: provider.baseUrl, seed, seedInteger: blindSeedInteger(seed), pairKey: pair.pairKey, specDigest: pair.specDigest, promptDigest, prompt, request: generation.request, responseStatus: generation.responseStatus, wallMillis: generation.wallMillis, seedEnforcement: generation.seedEnforcement, startedAt }, null, 2), { flag: "wx" });
    await writeFile(join(trialDirectory, "generation.json"), JSON.stringify({ response: generation.response, source: generation.source, problem: generation.problem }, null, 2), { flag: "wx" });
    let observation = null;
    if (generation.source !== null) { observation = await execute(trialDirectory, generation.source, blindDriverSource(pair.functionName), pair.declaredInputs, imageId); await writeFile(join(trialDirectory, "observation.json"), JSON.stringify(observation, null, 2), { flag: "wx" }); }
    const withSourceProbes = manifest.planned.filter(entry => entry.providerId === provider.id && entry.seed === seed && pair.cases.some(member => member.caseKey === entry.caseKey)).flatMap(entry => vectors.get(entry.attemptId) ?? []);
    const comparison = compareBlindObservation(observation?.execution ?? null, pair, withSourceProbes);
    await writeFile(join(trialDirectory, "comparison.json"), JSON.stringify(comparison, null, 2), { flag: "wx" });
    trials.push({ providerId: provider.id, model: provider.model, seed, pairKey: pair.pairKey, specDigest: pair.specDigest, directory: relative(armRoot, trialDirectory).split("\\").join("/"), promptDigest, generated: generation.source !== null, executed: comparison.blindExecuted, problem: generation.problem ?? observation?.problem ?? null, comparison });
    await write();
    console.log(JSON.stringify({ phase: "blind-finished", providerId: provider.id, pairKey: pair.pairKey, generated: generation.source !== null, executed: comparison.blindExecuted, blindEqualsIntended: comparison.blindEqualsIntended, defectiveProbeEqual: comparison.blindEqualsFirstWithSourceProbe.defective }));
  }
  await write();
  return { root: armRoot, planned, ...aggregateBlindTrials(trials) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runBlindSourceArm(process.argv[2], { development: process.argv.includes("--development") });
  console.log(JSON.stringify(result));
  if (result.generated !== result.planned) process.exitCode = 1;
}
