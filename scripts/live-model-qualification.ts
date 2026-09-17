import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compileIntentContract } from "../packages/core/dist/index.js";
import { canonicalize, digestJson, sha256Digest, type JsonValue } from "../packages/protocol/dist/index.js";
import { DEFAULT_SEARCH_PROFILE, OpenAICompatibleMindAdapter, investigationImplementationDescriptor, makePublicMindPrompt, mindFailureInputUpperBound, type MindAdapter, type MindRequest, type PublicContribution } from "../packages/runtime/dist/index.js";
import { createDaemonRuntime } from "../apps/daemon/dist/runtime.js";
import { createJevyrHttpService } from "../apps/daemon/dist/server.js";
import { JevyrClient } from "../packages/sdk/dist/index.js";
import { exportLocalProof } from "../apps/cli/dist/local-proof.js";

const F = await import(new URL("../benchmarks/live-model-fixtures.mjs", import.meta.url).href);
const V = await import(new URL("../benchmarks/verify-live-model-qualification.mjs", import.meta.url).href);
const G = await import(new URL("../benchmarks/generated-source-fixtures.mjs", import.meta.url).href);
assert.equal([...process.execArgv, process.env.NODE_OPTIONS ?? ""].some(value => /(?:conditions[=\s]+|^)(?:[^\s]*,)?development(?:,|\s|$)/u.test(value)), false,
  "Qualification uses the coherent production dist build; remove development import conditions");
const hash = (value: unknown) => digestJson(value as JsonValue);
const args = new Map<string, string | true>();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index]!;
  if (!["--config", "--output", "--execute", "--measure-recovery"].includes(key) || args.has(key)) throw new Error("Use --config FILE [--output NEW_DIRECTORY] [--execute] [--measure-recovery]; unknown/duplicate options are refused");
  if (key === "--execute" || key === "--measure-recovery") args.set(key, true);
  else { const value = process.argv[++index]; if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`); args.set(key, value); }
}
assert.equal(typeof args.get("--config"), "string", "--config is required");
const configBytes = await readFile(resolve(args.get("--config") as string)); assert.ok(configBytes.length <= 65_536);
const config = F.validateQualificationConfig(JSON.parse(configBytes.toString("utf8")));
const repository = resolve(import.meta.dirname, ".."), artifacts = join(repository, "artifacts");
const root = resolve(args.get("--output") as string ?? join(artifacts, `live-model-qualification-${Date.now()}`));
const part = relative(artifacts, root); assert.ok(part && !part.startsWith("..") && !isAbsolute(part), "Output must be a fresh directory within repository artifacts");
await mkdir(dirname(root), { recursive: true }); await mkdir(root);
const corpus = G.corpusForConfig(config), implementation = investigationImplementationDescriptor();
const search = { ...DEFAULT_SEARCH_PROFILE, nursery: { minimumAttempts: 2, saturationWindow: 2, independentLineages: 1, challengeInterval: 3 },
  resources: { ...DEFAULT_SEARCH_PROFILE.resources, maxMindInvocations: 6, maxInputTokens: 600_000, maxOutputTokens: 48_000, maxWallMillis: 900_000,
    maxSingleInvocationMillis: 180_000, maxGeneratedBytes: 2_000_000, maxForgeWallMillis: 180_000, maxWritableBytes: 128_000_000, maxArtifactBytes: 32_000_000, maxTotalAssayCost: 24, concurrentLineages: 1 } };
const contract = compileIntentContract({ impulse: corpus.impulse, constraints: corpus.constraints, subjectIds: ["fixture-source"] });
assert.equal(contract.criticalObligations.length, 1); assert.equal(contract.criticalObligations[0]!.oracle?.operand, F.SOURCE_COMMAND);
const plans = [
  { assayId: F.SOURCE_ASSAY_ID, costUnits: 1, tool: "forge.command", args: { command: "node", args: ["/subject/subject-0000/truth-oracle.mjs"] }, timeoutMs: 30_000, obligationId: contract.criticalObligations[0]!.id },
  { assayId: F.PROBE_ASSAY_ID, costUnits: 1, tool: "forge.command", args: { command: "node", args: ["jevyr.experiment.mjs"] }, timeoutMs: 30_000 },
];
const planned: any[] = [];
for (const provider of config.providers) for (const seed of config.seeds) for (let repeat = 0; repeat < config.repeats; repeat++) for (const fixture of corpus.cases) {
  const identity = { providerId: provider.id, seed, repeat, caseKey: fixture.caseKey };
  planned.push({ ...identity, attemptId: hash(identity).slice(7, 31), directory: `attempt-${String(planned.length + 1).padStart(3, "0")}` });
}
const retainedSources = [
  { name: "runner-source.ts", field: "runnerDigest", bytes: await readFile(import.meta.filename) },
  { name: "fixture-generator-source.mjs", field: "fixtureGeneratorDigest", bytes: await readFile(new URL("../benchmarks/live-model-fixtures.mjs", import.meta.url)) },
  { name: "verifier-source.mjs", field: "verifierDigest", bytes: await readFile(new URL("../benchmarks/verify-live-model-qualification.mjs", import.meta.url)) },
  { name: "generated-fixture-generator-source.mjs", field: "generatedFixtureGeneratorDigest", bytes: await readFile(new URL("../benchmarks/generated-source-fixtures.mjs", import.meta.url)) },
];
console.log(JSON.stringify({ phase: "planned", corpusKind: corpus.kind ?? "fixed", cases: corpus.cases.length, planned: planned.length }));
for (const source of retainedSources) await writeFile(join(root, source.name), source.bytes, { flag: "wx" });
let recoveryMeasurement: unknown;
if (args.has("--measure-recovery")) {
  const module = await import(new URL("../benchmarks/probe-recovery-measurement.mjs", import.meta.url).href);
  const analyzerBytes = await readFile(new URL("../benchmarks/probe-recovery-measurement.mjs", import.meta.url));
  recoveryMeasurement = module.recoveryMeasurementDeclaration(analyzerBytes);
  await writeFile(join(root, module.RECOVERY_ANALYZER_ARCHIVE), analyzerBytes, { flag: "wx" });
}
const manifestBody = { protocol: "jevyr.live-model-qualification/1", config, corpus, implementation, search, plans, planned,
  runtimeLoader: "compiled-dist",
  candidateCoverage: V.FINITE_CANDIDATE_COVERAGE,
  candidateCoverageScope: "Every authenticated model-origin finite blueprint in a committed original or revision population must execute. Abstract candidate ideas outside that population are reported separately. Original manifests without this field retain their legacy all-candidate-event criterion.",
  ...(recoveryMeasurement === undefined ? {} : { recoveryMeasurement }),
  ...Object.fromEntries(retainedSources.map(source => [source.field, sha256Digest(source.bytes)])),
  qualificationRule: corpus.qualificationRule, inferenceAuthorized: args.has("--execute"),
  providerIdentityScope: "Explicit configured model and provider-reported Ollama artifact digest; metadata does not remotely attest which weights serviced an inference.",
  denominator: "Every predeclared attempt, including failure, timeout, unavailable provider, INVALID, UNPROVEN, and incorrect probes." };
const manifest = { ...manifestBody, digest: hash(manifestBody) };
await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
if (!args.has("--execute")) {
  await writeFile(join(root, "report.json"), JSON.stringify({ protocol: "jevyr.live-model-qualification-report/1", manifestDigest: manifest.digest, status: "PREPARED_NO_INFERENCE", planned: planned.length, attempted: 0, qualified: 0, attempts: [] }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ root, status: "PREPARED_NO_INFERENCE", planned: planned.length }));
} else {
  async function providerSnapshot(provider: any) {
    const origin = new URL(provider.baseUrl).origin;
    async function json(path: string) {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      assert.equal(response.status, 200); assert.ok(response.body);
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length; assert.ok(total <= 1_048_576); chunks.push(next.value); } }
      finally { void reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    const [version, tags] = await Promise.all([json("/api/version"), json("/api/tags")]);
    const entry = tags.models?.find((model: any) => model.name === provider.model); assert.ok(entry, "Configured model is not installed; no pull is attempted");
    const digest = String(entry.digest).startsWith("sha256:") ? entry.digest : `sha256:${entry.digest}`;
    assert.equal(digest, provider.modelDigest, "Configured model artifact changed");
    const body = { protocol: "jevyr.local-provider-snapshot/1", provider, serverVersion: version.version, modelDigest: digest, modelSize: entry.size, modelDetails: entry.details };
    return { ...body, digest: hash(body) };
  }
  async function exportCapture(dataDir: string, caseId: string, proof: string) {
    const capture = JSON.parse(await readFile(join(dataDir, "cases", caseId, "subject-materials.json"), "utf8"));
    const destination = join(proof, "subject-materials"); await mkdir(join(destination, "manifests"), { recursive: true }); await mkdir(join(destination, "blobs"));
    await writeFile(join(destination, "capture.json"), JSON.stringify({ protocol: "jevyr.subject-material-capture/1", bindings: capture.bindings, captureDigest: capture.captureDigest }, null, 2), { flag: "wx" });
    for (const binding of capture.bindings) {
      assert.match(binding.manifestDigest, /^sha256:[a-f0-9]{64}$/u);
      const bytes = await readFile(join(dataDir, "subject-materials", "manifests", binding.manifestDigest.slice(7))); assert.equal(sha256Digest(bytes), binding.manifestDigest);
      await writeFile(join(destination, "manifests", binding.manifestDigest.slice(7)), bytes, { flag: "wx" });
      for (const entry of JSON.parse(bytes.toString("utf8")).entries) {
        assert.match(entry.blobDigest, /^sha256:[a-f0-9]{64}$/u);
        const blob = await readFile(join(dataDir, "subject-materials", "blobs", entry.blobDigest.slice(7))); assert.equal(sha256Digest(blob), entry.blobDigest); assert.equal(blob.length, entry.byteLength);
        await writeFile(join(destination, "blobs", entry.blobDigest.slice(7)), blob, { flag: "wx" });
      }
    }
  }
  const attempts: any[] = [];
  for (const plannedAttempt of planned) {
    const directory = join(root, plannedAttempt.directory), project = join(directory, "project"), dataDir = join(directory, "store"), source = join(project, "source");
    await mkdir(join(project, ".jevyr"), { recursive: true }); await mkdir(source);
    const fixture = corpus.cases.find((value: any) => value.caseKey === plannedAttempt.caseKey), provider = config.providers.find((value: any) => value.id === plannedAttempt.providerId);
    for (const file of fixture.files) await writeFile(join(source, file.path), file.content, { flag: "wx" });
    await writeFile(join(project, ".jevyr", "policy.json"), JSON.stringify({ protocol: "jevyr.policy/1", policyVersion: "bone-v1", semanticContinuation: false,
      reflex: { required: true, maximumLoops: 2 }, forge: { network: "denied", source: "read_only", missingDocker: "INVALID", dockerImage: config.dockerImage, limits: { memoryMb: 1024, pidsLimit: 128 } },
      memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 }, growth: { liveBoneMutation: false, promotion: "signed_governance" }, search }), { flag: "wx" });
    await writeFile(join(project, ".jevyr", "assay-frontier.json"), JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: plans }), { flag: "wx" });
    const started = { ...plannedAttempt, manifestDigest: manifest.digest, startedAt: new Date().toISOString(), status: "STARTED" };
    await writeFile(join(directory, "started.json"), JSON.stringify(started, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ phase: "started", root, ...plannedAttempt }));
    let runtime: ReturnType<typeof createDaemonRuntime> | undefined, service: ReturnType<typeof createJevyrHttpService> | undefined, client: JevyrClient | undefined, caseId: string | undefined;
    const invocations: unknown[] = []; const outcome: any = { ...started, status: "FAILED", qualified: false };
    try {
      const snapshot = await providerSnapshot(provider); outcome.providerSnapshot = snapshot;
      const adapter = new OpenAICompatibleMindAdapter({ ...provider, displayName: `Qualification ${provider.model}`, timeoutMs: search.resources.maxSingleInvocationMillis, maxResponseBytes: 1_048_576 });
      const mind: MindAdapter = {
        capability: Object.freeze({ ...adapter.capability, limits: Object.freeze({ ...adapter.capability.limits, qualificationManifestDigest: manifest.digest, providerSnapshotDigest: snapshot.digest, providerReportedModelDigest: provider.modelDigest }) }),
        probe: () => adapter.probe(),
        async *run(request: MindRequest): AsyncIterable<PublicContribution> { const result = await this.runMetered!(request); yield* result.contributions; },
        async runMetered(request: MindRequest) {
          const call = { ordinal: invocations.length + 1, stage: request.stage, role: request.role, seed: request.seed, promptDigest: sha256Digest(makePublicMindPrompt(request)), startedAt: new Date().toISOString() };
          try { const result = await adapter.runMetered(request); invocations.push({ ...call, status: "RETURNED", result }); return result; }
          catch (error) { invocations.push({ ...call, status: "FAILED", error: error instanceof Error ? error.message : "Provider contract failed", transmittedInputUpperBound: mindFailureInputUpperBound(error, 0) }); throw error; }
        },
      };
      runtime = createDaemonRuntime({ projectRoot: project, dataDir, env: {}, minds: [mind] });
      service = createJevyrHttpService({ runtime, env: {} }); const address = await service.listen(0, "127.0.0.1"); client = new JevyrClient({ baseUrl: address.url });
      const seal = await client.cast({ case: { impulse: corpus.impulse, constraints: corpus.constraints, seed: plannedAttempt.seed, privacy: "local_only", control: "sovereign", subjects: [{ id: "fixture-source", kind: "directory", locator: source }] } });
      caseId = seal.caseId; outcome.caseId = caseId;
      const authenticated = await client.waitForAuthenticatedRecord(caseId, { signal: AbortSignal.timeout(search.resources.maxWallMillis + 120_000), preferSse: false });
      outcome.signerKeyId = authenticated.keyId; outcome.verdict = authenticated.payload.verdict;
      outcome.replay = await exportLocalProof(client, caseId, join(directory, "proof"));
      await exportCapture(dataDir, caseId, join(directory, "proof"));
      outcome.providerSnapshotAfter = await providerSnapshot(provider); assert.equal(outcome.providerSnapshotAfter.digest, snapshot.digest, "Provider metadata changed during the attempt");
      outcome.qualification = await V.verifyQualificationAttempt(root, plannedAttempt.attemptId, { expectedSignerKeyId: authenticated.keyId, providerSnapshot: snapshot });
      outcome.qualified = outcome.qualification.qualified && invocations.every((value: any) => value.status === "RETURNED"); outcome.status = outcome.qualified ? "QUALIFIED" : "FAILED";
    } catch (error) {
      outcome.error = (error instanceof Error ? error.message : "Qualification attempt failed").slice(0, 8192);
      if (caseId && runtime && client && !outcome.replay) {
        try { runtime.orchestrator.abort(caseId); await runtime.orchestrator.waitForTerminal(caseId, 60_000); outcome.abortedReplay = await exportLocalProof(client, caseId, join(directory, "aborted-proof")); }
        catch (failure) { outcome.abortExportError = (failure instanceof Error ? failure.message : "Terminal recovery export failed").slice(0, 8192); }
      }
    } finally {
      await writeFile(join(directory, "invocations.json"), JSON.stringify({ protocol: "jevyr.qualification-invocations/1", attemptId: plannedAttempt.attemptId, invocations }, null, 2), { flag: "wx" });
      try { if (service) await service.close(); else if (runtime) await runtime.close(); } catch (error) { outcome.closeError = String(error).slice(0, 8192); outcome.qualified = false; outcome.status = "FAILED"; }
    }
    outcome.finishedAt = new Date().toISOString(); outcome.invocations = invocations.length;
    await writeFile(join(directory, "result.json"), JSON.stringify(outcome, null, 2), { flag: "wx" }); attempts.push(outcome);
    await writeFile(join(root, "progress.json"), JSON.stringify({ manifestDigest: manifest.digest, planned: planned.length, attempted: attempts.length, attempts }, null, 2));
    console.log(JSON.stringify({ phase: "finished", attemptId: plannedAttempt.attemptId, status: outcome.status, caseId, judgment: outcome.verdict?.judgment, error: outcome.error }));
  }
  const result = { protocol: "jevyr.live-model-qualification-report/1", manifestDigest: manifest.digest, status: attempts.every(value => value.qualified) ? "QUALIFIED" : "FAILED", planned: planned.length, attempted: attempts.length, qualified: attempts.filter(value => value.qualified).length, attempts };
  await writeFile(join(root, "report.json"), JSON.stringify(result, null, 2), { flag: "wx" }); console.log(JSON.stringify({ root, planned: result.planned, qualified: result.qualified, status: result.status }));
  if (result.status !== "QUALIFIED") process.exitCode = 1;
}
