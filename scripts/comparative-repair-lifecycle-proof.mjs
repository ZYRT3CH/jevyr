import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileIntentContract } from "../packages/core/dist/index.js";
import { canonicalize, digestJson, sha256Digest } from "../packages/protocol/dist/index.js";
import { DEFAULT_SEARCH_PROFILE, REVISION_INVESTIGATION_POLICY, conservativeUsage, decodeExactByteCapture,
  investigationImplementationDescriptor, makePublicMindPrompt, revisionInvestigationVersion } from "../packages/runtime/dist/index.js";
import { metabolicImplementationDigest } from "../packages/runtime/dist/juggler-calibration.js";
import { createDaemonRuntime } from "../apps/daemon/dist/runtime.js";
import { loadProjectPolicy } from "../apps/daemon/dist/project-policy.js";
import { createJevyrHttpService } from "../apps/daemon/dist/server.js";
import { JevyrClient } from "../packages/sdk/dist/index.js";
import { allEvents, replayAuthenticatedCase } from "../apps/cli/dist/replay.js";
import { exportLocalProof, verifyLocalProof } from "../apps/cli/dist/local-proof.js";

assert.equal([...process.execArgv, process.env.NODE_OPTIONS ?? ""].some(value => /conditions.*development/u.test(value)), false,
  "This proof must use the coherent installed build");
const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), ".."), artifacts = join(repository, "artifacts");
const verifying = process.argv[2] === "--verify";
assert.equal(process.argv.length, verifying ? 5 : 3, "Pass one fresh artifact directory, or --verify DIRECTORY PINNED_SIGNER_KEY");
const root = resolve(process.argv[verifying ? 3 : 2]), part = relative(artifacts, root);
assert.ok(part && !part.startsWith("..") && !isAbsolute(part), "Output must stay inside repository artifacts");
const SOURCE_ASSAY = "repair.immutable-source", PROBE_ASSAY = "repair.comparative-probe", ENTRY = "comparative-probe.mjs";
const SOURCE_COMMAND = "node /subject/subject-0000/truth-oracle.mjs", GOOD_IMPORT = "/subject/subject-0000/add.mjs", MISSING_IMPORT = "./missing-helper.mjs";
const expectedOutput = '{"protocol":"jevyr.comparative-repair-observation/1","observed":5}\n';
const sourceFiles = [
  { path: "add.mjs", content: "export const add=(a,b)=>a+b;\n" },
  { path: "truth-oracle.mjs", content: `import {add} from "./add.mjs";\nconst observed=add(2,3);\nprocess.stdout.write(JSON.stringify({protocol:"jevyr.comparative-repair-observation/1",observed})+"\\n");\nprocess.exit(observed===5?0:9);\n` },
];
const impulse = `\`${SOURCE_COMMAND}\` exits with code 0.`;
const contract = compileIntentContract({ impulse, subjectIds: ["fixture-source"] });
assert.equal(contract.criticalObligations.length, 1); assert.equal(contract.criticalObligations[0].oracle?.operand, SOURCE_COMMAND);
const plans = [
  { assayId: SOURCE_ASSAY, tool: "forge.command", args: { command: "node", args: ["/subject/subject-0000/truth-oracle.mjs"] }, costUnits: 1, timeoutMs: 30_000, obligationId: contract.criticalObligations[0].id },
  { assayId: PROBE_ASSAY, tool: "forge.command", args: { command: "node", args: [ENTRY] }, costUnits: 1, timeoutMs: 30_000 },
].sort((left, right) => left.assayId < right.assayId ? -1 : left.assayId > right.assayId ? 1 : 0);
const search = { ...DEFAULT_SEARCH_PROFILE, nursery: { minimumAttempts: 2, saturationWindow: 2, independentLineages: 1, challengeInterval: 3 },
  resources: { ...DEFAULT_SEARCH_PROFILE.resources, maxMindInvocations: 8, maxInputTokens: 600_000, maxOutputTokens: 48_000,
    maxWallMillis: 240_000, maxSingleInvocationMillis: 30_000, maxGeneratedBytes: 2_000_000, maxForgeWallMillis: 120_000,
    maxWritableBytes: 16_000_000, maxArtifactBytes: 32_000_000, maxTotalAssayCost: 32, concurrentLineages: 1 } };
const methodFiles = ["packages/runtime/dist/baseline-revision.js", "packages/runtime/dist/revision-investigation.js", "packages/runtime/dist/evidence-replay.js",
  "packages/runtime/dist/orchestrator.js", "packages/runtime/dist/forge.js", "packages/core/dist/policy.js", "packages/core/dist/reflex.js",
  "apps/daemon/dist/runtime.js", "apps/daemon/dist/server.js", "apps/cli/dist/local-proof.js", "apps/cli/dist/replay.js"];
const snapshot = async () => ({ investigation: investigationImplementationDescriptor(), metabolic: metabolicImplementationDigest(),
  files: await Promise.all(methodFiles.map(async path => ({ path, digest: sha256Digest(await readFile(join(repository, path))) }))) });
const json = async path => JSON.parse((await readFile(path)).toString("utf8"));
const captureText = capture => { assert.equal(capture.complete, true); const decoded = decodeExactByteCapture(capture); assert.equal(typeof decoded.text, "string"); return decoded.text; };
const initialSource = seed => `// Held logical invocation ${seed}\nimport {add} from "${MISSING_IMPORT}";\nconst observed=add(2,3);\nprocess.stdout.write(JSON.stringify({protocol:"jevyr.comparative-repair-observation/1",observed})+"\\n");\n`;

// These bytes are retained for offline inspection only. The verifier never
// imports subject code, generated candidate code, or an archived runner.
async function exportCapture(dataDir, caseId, proof) {
  const capture = await json(join(dataDir, "cases", caseId, "subject-materials.json"));
  const destination = join(proof, "subject-materials");
  await mkdir(join(destination, "manifests"), { recursive: true }); await mkdir(join(destination, "blobs"));
  await writeFile(join(destination, "capture.json"), JSON.stringify({ protocol: "jevyr.subject-material-capture/1", captureDigest: capture.captureDigest, bindings: capture.bindings }, null, 2), { flag: "wx" });
  const exported = new Set();
  for (const binding of capture.bindings) {
    assert.match(binding.manifestDigest, /^sha256:[a-f0-9]{64}$/u);
    const bytes = await readFile(join(dataDir, "subject-materials", "manifests", binding.manifestDigest.slice(7)));
    assert.equal(sha256Digest(bytes), binding.manifestDigest);
    await writeFile(join(destination, "manifests", binding.manifestDigest.slice(7)), bytes, { flag: "wx" });
    for (const entry of JSON.parse(bytes.toString("utf8")).entries) {
      assert.match(entry.blobDigest, /^sha256:[a-f0-9]{64}$/u);
      if (exported.has(entry.blobDigest)) continue;
      const blob = await readFile(join(dataDir, "subject-materials", "blobs", entry.blobDigest.slice(7)));
      assert.equal(sha256Digest(blob), entry.blobDigest); assert.equal(blob.length, entry.byteLength);
      await writeFile(join(destination, "blobs", entry.blobDigest.slice(7)), blob, { flag: "wx" }); exported.add(entry.blobDigest);
    }
  }
}

async function verifyRetained(expectedKey) {
  assert.match(expectedKey, /^sha256:[a-f0-9]{64}$/u);
  const manifest = await json(join(root, "manifest.json")), { digest, ...body } = manifest;
  assert.equal(digestJson(body), digest); assert.equal(manifest.runnerDigest, sha256Digest(await readFile(join(root, "runner-source.mjs"))));
  assert.equal(manifest.protocol, "jevyr.comparative-repair-installed-proof/1");
  assert.deepEqual(manifest.fixture.sourceFiles, sourceFiles); assert.equal(manifest.fixture.impulse, impulse);
  assert.equal(manifest.fixture.expectedOutput, expectedOutput); assert.deepEqual(manifest.plans, plans);
  assert.deepEqual(manifest.revisionPolicy, REVISION_INVESTIGATION_POLICY); assert.equal(manifest.revisionPolicy.protocol, "jevyr.execution-revision-policy/2");
  assert.deepEqual(await snapshot(), manifest.implementation, "Loaded installed implementation changed since the predeclared experiment");
  const proof = join(root, "proof"), replay = await verifyLocalProof(proof, expectedKey);
  assert.equal(replay.valid, true, JSON.stringify(replay));
  const seal = await json(join(proof, "sealed-case.json")), record = await json(join(proof, "record.json")), events = await json(join(proof, "events.json"));
  const policy = (await json(join(proof, "policy-descriptor.json"))).artifact.descriptor;
  assert.equal(revisionInvestigationVersion(policy), "observed-comparative-repair");
  assert.deepEqual(policy.policy.executionRevisions, manifest.revisionPolicy);
  assert.equal(seal.intent.impulse, impulse); assert.equal(seal.intent.seed, manifest.fixture.seed);
  assert.equal(seal.intent.privacy, "local_only"); assert.equal(seal.intent.control, "sovereign");
  assert.deepEqual(policy.policy.assayFrontier.assays, plans);
  assert.equal(policy.policy.mindCapabilities.length, 1);
  assert.equal(policy.policy.mindCapabilities[0].limits.fixtureManifestDigest, digest);
  assert.deepEqual(record.verdict.integrity, "VALID"); assert.equal(record.verdict.judgment, "ACCEPT");
  assert.equal(record.verdict.creation, "CONCEIVED"); assert.equal(record.verdict.embodiment, "BUILT");

  const materialRoot = join(proof, "subject-materials"), capture = await json(join(materialRoot, "capture.json"));
  assert.equal(capture.captureDigest, seal.subjectMaterialCaptureDigest);
  assert.equal(capture.captureDigest, digestJson({ protocol: capture.protocol, bindings: capture.bindings }));
  assert.deepEqual(capture.bindings.map(value => value.subjectId), ["fixture-source"]);
  const binding = capture.bindings[0], materialBytes = await readFile(join(materialRoot, "manifests", binding.manifestDigest.slice(7)));
  assert.equal(sha256Digest(materialBytes), binding.manifestDigest);
  const material = JSON.parse(materialBytes.toString("utf8")); assert.equal(material.availability, "MATERIALIZED");
  assert.equal(material.subjectDigest, binding.subjectDigest); assert.equal(material.subjectId, "fixture-source");
  assert.deepEqual(material.entries.map(value => value.path).sort(), sourceFiles.map(value => value.path).sort());
  let materialSize = 0;
  for (const entry of material.entries) {
    const bytes = await readFile(join(materialRoot, "blobs", entry.blobDigest.slice(7)));
    assert.equal(sha256Digest(bytes), entry.blobDigest); assert.equal(bytes.length, entry.byteLength);
    assert.equal(bytes.toString("utf8"), sourceFiles.find(file => file.path === entry.path).content); materialSize += bytes.length;
  }
  assert.equal(material.byteLength, materialSize); assert.equal(binding.byteLength, materialSize);
  const materializationDigest = digestJson({ protocol: "jevyr.subject-materialization/1", subjects: [{ subjectId: "fixture-source", availability: "MATERIALIZED", relativeRoot: "subject-0000", manifestDigest: binding.manifestDigest, files: material.entries.length, byteLength: materialSize }] });
  const index = await json(join(proof, "artifact-index.json")), bodies = new Map();
  for (const meta of index.artifacts) {
    const bytes = await readFile(join(proof, "artifacts", `${meta.id}.blob`)); assert.equal(sha256Digest(bytes), meta.digest); assert.equal(bytes.length, meta.size);
    if (meta.mediaType.endsWith("+json")) bodies.set(meta.digest, { meta, value: JSON.parse(bytes.toString("utf8")) });
  }
  const action = (type, digest) => events.find(event => event.kind === "action.status" && event.actor.kind === "kernel" && event.actor.id === "jevyr.bone"
    && event.payload.actionType === type && event.payload.status === "completed" && event.payload.artifactDigests?.includes(digest));
  const populations = [...bodies].filter(([, entry]) => entry.meta.mediaType === "application/vnd.jevyr.candidate-population+json"); assert.equal(populations.length, 1);
  const [populationDigest, { value: population }] = populations[0]; assert.ok(action("candidate.population.close", populationDigest));
  const revisions = [...bodies].filter(([, entry]) => entry.meta.mediaType === "application/vnd.jevyr.revision-population+json"); assert.equal(revisions.length, 1, "Exactly one baseline repair must occur");
  const [revisionDigest, { value: revision }] = revisions[0], revisionAction = action("candidate.revision.population.close", revisionDigest); assert.ok(revisionAction);
  assert.equal(revision.round, 1); assert.equal(revision.ordinal, 1); assert.equal(revision.receiptDigest, undefined); assert.equal(revision.inertiaDecisionDigest, undefined);
  assert.equal(revision.previousPopulationDigest, populationDigest); assert.equal(revision.candidates.length, 1); assert.equal(revision.parentCandidateIds.length, 1);
  const parentId = revision.parentCandidateIds[0], childId = revision.candidates[0].candidateId;
  const parents = new Set(population.candidates.map(candidate => candidate.candidateId)); assert.ok(parents.size >= 2 && parents.has(parentId) && !parents.has(childId));
  const parentBlueprint = bodies.get(population.candidates.find(value => value.candidateId === parentId).blueprintArtifactDigest).value;
  const childBlueprint = bodies.get(revision.candidates[0].blueprintArtifactDigest).value;
  assert.equal(parentBlueprint.files.length, 1); assert.equal(childBlueprint.files.length, 1);
  assert.equal(parentBlueprint.files[0].path, ENTRY); assert.equal(childBlueprint.files[0].path, ENTRY);
  assert.ok(parentBlueprint.files[0].content.includes(`from "${MISSING_IMPORT}"`));
  assert.equal(childBlueprint.files[0].content, parentBlueprint.files[0].content.replace(`from "${MISSING_IMPORT}"`, `from "${GOOD_IMPORT}"`));
  assert.equal(parentBlueprint.files[0].digest, sha256Digest(parentBlueprint.files[0].content)); assert.equal(childBlueprint.files[0].digest, sha256Digest(childBlueprint.files[0].content));
  const feedback = bodies.get(revision.feedbackArtifactDigest).value, feedbackAction = action("investigation.execution-feedback", revision.feedbackArtifactDigest);
  assert.ok(feedbackAction && feedbackAction.sequence < revisionAction.sequence);
  const calls = await json(join(root, "fixture-calls.json")), repairCalls = calls.filter(call => call.revision);
  assert.equal(repairCalls.length, 1); assert.ok(calls.every(call => call.status === "RETURNED"));
  const repairCall = repairCalls[0]; assert.deepEqual(repairCall.revision.parentCandidateIds, [parentId]);
  assert.equal(repairCall.parentBlueprintDigest, parentBlueprint.blueprintDigest); assert.equal(repairCall.revision.contextDigest, feedback.contextDigest);
  assert.equal(repairCall.contributions.length, 1); assert.deepEqual(repairCall.contributions[0].parentIds, [parentId]);
  const observations = [...bodies].filter(([, entry]) => entry.meta.mediaType === "application/vnd.jevyr.tool-observation+json"
    && [SOURCE_ASSAY, PROBE_ASSAY].includes(entry.value.metadata?.assayId));
  assert.ok(observations.length >= 6); assert.equal(new Set(observations.map(([, entry]) => entry.value.invocationId)).size, observations.length);
  const sourceRows = [], probeRows = [];
  for (const [observationDigest, { value }] of observations) {
    const meta = value.metadata, execution = value.oracle.execution, boundary = value.oracle.subjectBoundary;
    assert.equal(meta.planBoundAtSeal, true); assert.equal(meta.executionAuthorityStatus, "VERIFIED"); assert.equal(meta.aggregateAdmissible, true);
    assert.equal(execution.mode, "docker"); assert.equal(execution.state, "exited"); assert.equal(execution.command, "node"); assert.equal(execution.shell, false);
    assert.equal(boundary.captureDigest, seal.subjectMaterialCaptureDigest); assert.equal(boundary.materializationDigest, materializationDigest);
    assert.equal(boundary.sealedSubjectReadOnly, true); assert.equal(boundary.originalSubjectAccessible, false); assert.equal(boundary.beforeDigest, boundary.afterDigest);
    const stdout = captureText(execution.stdoutCapture), stderr = captureText(execution.stderrCapture);
    const row = { digest: observationDigest, invocationId: value.invocationId, candidateId: meta.candidateId, exitCode: execution.exitCode,
      stdoutDigest: execution.stdoutCapture.digest, stderrDigest: execution.stderrCapture.digest };
    assert.ok(parents.has(meta.candidateId) || meta.candidateId === childId);
    if (meta.assayId === SOURCE_ASSAY) {
      assert.deepEqual(execution.args, ["/subject/subject-0000/truth-oracle.mjs"]); assert.equal(execution.exitCode, 0); assert.equal(stdout, expectedOutput); sourceRows.push(row);
    } else {
      assert.deepEqual(execution.args, [ENTRY]);
      if (meta.candidateId === childId) { assert.equal(execution.exitCode, 0); assert.equal(stdout, expectedOutput); }
      else { assert.equal(execution.exitCode, 1); assert.equal(stdout, ""); assert.match(stderr, /ERR_MODULE_NOT_FOUND/u); assert.ok(stderr.includes("missing-helper.mjs")); }
      probeRows.push(row);
    }
    const boundIndex = feedback.observationBindings.findIndex(item => item.observationDigest === observationDigest);
    if (boundIndex >= 0) {
      const cell = feedback.cells[boundIndex], fact = repairCall.feedbackFacts.find(item => item.body.candidateId === cell.candidateId && item.body.assayId === cell.assayId
        && item.body.outputCapture?.stderr.digest === execution.stderrCapture.digest && item.body.outputCapture?.stdout.digest === execution.stdoutCapture.digest);
      assert.ok(fact, "The fixture must receive the exact preceding byte capture through public feedback facts");
      for (const stream of ["stdout", "stderr"]) {
        const captured = decodeExactByteCapture(execution[`${stream}Capture`]), displayed = fact.body[stream], context = fact.body.outputCapture[stream];
        assert.equal(context.status, "CAPTURED"); assert.equal(context.digest, execution[`${stream}Capture`].digest);
        assert.equal(context.retainedBytes, captured.bytes.length); assert.equal(context.observedBytes, captured.bytes.length); assert.equal(context.complete, true);
        assert.equal(context.displayBytes, Buffer.byteLength(displayed)); assert.ok(context.displayBytes <= 2_000);
        assert.deepEqual(Buffer.from(displayed), Buffer.from(captured.bytes.subarray(0, context.displayBytes)));
        assert.equal(context.truncated, context.displayBytes < captured.bytes.length);
      }
    }
  }
  for (const id of [...parents, childId]) { assert.ok(sourceRows.some(row => row.candidateId === id)); assert.ok(probeRows.some(row => row.candidateId === id)); }
  const observedParentFailure = probeRows.find(row => row.candidateId === parentId && row.exitCode === 1);
  assert.ok(feedback.observationBindings.some(binding => binding.observationDigest === observedParentFailure.digest));
  assert.ok(feedback.cells.some(cell => cell.candidateId === parentId && cell.assayId === SOURCE_ASSAY && cell.decisive && cell.status === "PASSED"));
  assert.ok(feedback.cells.some(cell => cell.candidateId === parentId && cell.assayId === PROBE_ASSAY && cell.decisive && cell.status === "FAILED"));
  const originalEdge = contract.criticalObligations[0].id;
  assert.ok(events.some(event => event.kind === "evidence.observed" && event.payload.assayId === SOURCE_ASSAY && event.payload.supports?.includes(originalEdge)));
  assert.ok(events.filter(event => event.kind === "evidence.observed" && event.payload.assayId === PROBE_ASSAY).every(event => !event.payload.supports?.length && !event.payload.refutes?.length),
    "Comparative failures and repairs may not adjudicate the immutable source obligation");
  return { protocol: "jevyr.comparative-repair-independent-verification/1", valid: true, manifestDigest: digest, signerKeyId: expectedKey, caseId: seal.caseId,
    verdict: record.verdict, physicalObservations: observations.length, initialCandidates: parents.size, revisionCalls: repairCalls.length,
    parentId, childId, feedbackDigest: revision.feedbackArtifactDigest, sourceRows, probeRows, replay,
    scope: "One deterministic fixture with real Docker, exact executed feedback, bounded baseline repair and full signed proof replay. No language-model qualification or first-pass success claim." };
}

if (verifying) {
  let result;
  try { result = await verifyRetained(process.argv[4]); }
  catch (error) { result = { protocol: "jevyr.comparative-repair-independent-verification/1", valid: false, error: error instanceof Error ? error.stack : String(error) }; }
  await writeFile(join(root, "independent-verification.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ root, valid: result.valid, physicalObservations: result.physicalObservations }));
  if (!result.valid) process.exitCode = 1;
} else {
  await mkdir(root);
  const implementation = await snapshot(); assert.equal(REVISION_INVESTIGATION_POLICY.protocol, "jevyr.execution-revision-policy/2");
  const runnerBytes = await readFile(script); await writeFile(join(root, "runner-source.mjs"), runnerBytes, { flag: "wx" });
  const manifestBody = { protocol: "jevyr.comparative-repair-installed-proof/1", createdAt: new Date().toISOString(), runtimeLoader: "compiled-dist",
    runnerDigest: sha256Digest(runnerBytes), implementation, revisionPolicy: REVISION_INVESTIGATION_POLICY, search, plans,
    fixture: { impulse, seed: "comparative-repair-held-seed", sourceFiles, missingImport: MISSING_IMPORT, repairImport: GOOD_IMPORT, expectedOutput },
    expectations: { initialCandidatesAtLeast: 2, initialProbeExit: 1, originalSourceExit: 0, revisionCalls: 1, revisedProbeExit: 0,
      finalAxes: { integrity: "VALID", creation: "CONCEIVED", embodiment: "BUILT", judgment: "ACCEPT" }, baselineHardCap: 2, comparativeVerdictAuthority: "none" },
    scope: "Mechanical fixture directly inspects its actual public feedback and committed parent bytes. Every failed attempt is retained. No model, provider tool-loop, broad repair efficacy, or historical strict cohort qualification is claimed." };
  const manifest = { ...manifestBody, digest: digestJson(manifestBody) }; await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  const project = join(root, "project"), source = join(root, "source"), dataDir = join(root, "store");
  await mkdir(join(project, ".jevyr"), { recursive: true }); await mkdir(source);
  for (const file of sourceFiles) await writeFile(join(source, file.path), file.content, { flag: "wx" });
  const base = loadProjectPolicy(project).policy;
  const policy = { ...base, policyVersion: "bone-v2", search, forge: { ...base.forge, dockerImage: "node:24-alpine", missingDocker: "INVALID" } };
  await writeFile(join(project, ".jevyr/policy.json"), JSON.stringify(policy), { flag: "wx" });
  await writeFile(join(project, ".jevyr/assay-frontier.json"), JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: plans }), { flag: "wx" });
  const calls = [];
  const mind = { capability: { id: "mind.comparative-repair-fixture", kind: "mind", displayName: "Deterministic feedback fixture; no language model", version: "1",
      transport: "in-process", trust: "local-deterministic", modalities: ["text"], network: "none", canExecuteTools: false, deterministic: true,
      limits: { fixtureManifestDigest: manifest.digest, measuredScope: "finite-scheduler-and-byte-feedback-only" } },
    async probe() { return { available: true, detail: "Bounded deterministic fixture; zero external model calls", latencyMs: 0, observedAt: new Date().toISOString() }; },
    async *run(request) {
      if (request.revision) {
        assert.equal(request.stage, "reflex"); assert.equal(request.revision.round, 1);
        assert.equal(request.revision.parentCandidateIds.length, 1);
        const parent = request.revisionSources?.find(value => value.candidateId === request.revision.parentCandidateIds[0]); assert.ok(parent);
        assert.equal(parent.files.length, 1); const file = parent.files[0]; assert.equal(file.path, ENTRY); assert.equal(file.digest, sha256Digest(file.content));
        const facts = request.publicFacts.filter(fact => fact.tags?.includes("executed-assay-context")).map(fact => JSON.parse(fact.body));
        assert.ok(facts.some(fact => fact.candidateId === parent.candidateId && fact.assayId === SOURCE_ASSAY && fact.status === "PASSED" && fact.decisive && fact.exitCode === 0));
        const failed = facts.find(fact => fact.candidateId === parent.candidateId && fact.assayId === PROBE_ASSAY && fact.status === "FAILED" && fact.decisive && fact.exitCode === 1);
        assert.ok(failed); assert.equal(failed.outputCapture.stderr.status, "CAPTURED"); assert.match(failed.stderr, /ERR_MODULE_NOT_FOUND/u); assert.ok(failed.stderr.includes("missing-helper.mjs"));
        assert.ok(file.content.includes(`from "${MISSING_IMPORT}"`));
        yield { id: `revision_${request.seed.slice(0, 20)}`, kind: "candidate", summary: "Repair the missing comparative import observed in actual stderr", parentIds: [parent.candidateId], feasibility: "BUILDABLE_NOW",
          candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: ENTRY, content: file.content.replace(`from "${MISSING_IMPORT}"`, `from "${GOOD_IMPORT}"`) }], command: { executable: "node", args: [ENTRY] } } };
      } else if (request.stage === "diverge") {
        assert.ok(request.experimentCapability.experiments.some(experiment => experiment.assayId === PROBE_ASSAY && experiment.authority === "comparative-only"));
        yield { id: `candidate_${request.seed.slice(0, 20)}`, kind: "candidate", summary: `Initial finite comparative probe ${request.seed.slice(0, 8)}`, parentIds: [], feasibility: "BUILDABLE_NOW",
          candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: ENTRY, content: initialSource(request.seed) }], command: { executable: "node", args: [ENTRY] } } };
      }
    },
    async runMetered(request) {
      const call = { ordinal: calls.length + 1, stage: request.stage, role: request.role, seed: request.seed, revision: request.revision ?? null,
        parentBlueprintDigest: request.revisionSources?.[0]?.blueprintDigest ?? null,
        feedbackFacts: request.publicFacts.filter(fact => fact.tags?.includes("executed-assay-context")).map(fact => ({ id: fact.id, body: JSON.parse(fact.body) })), status: "STARTED" };
      calls.push(call);
      try { const contributions = []; for await (const contribution of this.run(request)) contributions.push(contribution);
        const result = { contributions, ...conservativeUsage(makePublicMindPrompt(request), canonicalize(contributions)) };
        Object.assign(call, { status: "RETURNED", contributions, usage: { tokenUsage: result.tokenUsage, transmittedInputBytes: result.transmittedInputBytes, receivedOutputBytes: result.receivedOutputBytes } }); return result;
      } catch (error) { Object.assign(call, { status: "FAILED", error: error instanceof Error ? error.message : String(error) }); throw error; }
    } };
  const report = { protocol: "jevyr.comparative-repair-installed-proof-report/1", manifestDigest: manifest.digest, planned: 1, attempted: 1, passed: false };
  let runtime, service;
  try {
    runtime = createDaemonRuntime({ projectRoot: project, dataDir, env: {}, minds: [mind] });
    service = createJevyrHttpService({ runtime, env: {} }); const address = await service.listen(0, "127.0.0.1"), client = new JevyrClient({ baseUrl: address.url });
    const receipt = await client.cast({ case: { impulse, seed: manifest.fixture.seed, privacy: "local_only", control: "sovereign", subjects: [{ id: "fixture-source", kind: "directory", locator: source }] } });
    report.caseId = receipt.caseId; console.log(JSON.stringify({ phase: "sealed", root, caseId: receipt.caseId }));
    const authenticated = await client.waitForAuthenticatedRecord(receipt.caseId, { preferSse: false, signal: AbortSignal.timeout(300_000) });
    report.signerKeyId = authenticated.keyId; report.verdict = authenticated.payload.verdict;
    report.httpReplay = await replayAuthenticatedCase(client, receipt.caseId, authenticated.payload);
    report.export = await exportLocalProof(client, receipt.caseId, join(root, "proof"));
    await exportCapture(dataDir, receipt.caseId, join(root, "proof"));
    // Retain the HTTP ledger independently of in-process state access.
    assert.deepEqual(await allEvents(client, receipt.caseId), await json(join(root, "proof/events.json")));
    await writeFile(join(root, "fixture-calls.json"), JSON.stringify(calls, null, 2), { flag: "wx" });
    for (const file of sourceFiles) assert.equal(await readFile(join(source, file.path), "utf8"), file.content);
    assert.equal(report.httpReplay.valid, true, JSON.stringify(report.httpReplay)); assert.equal(report.export.valid, true, JSON.stringify(report.export));
    // A new process sees only exported bytes and the independently captured key;
    // it cannot reuse daemon state or the fixture's live receipt objects.
    const child = spawn(process.execPath, [script, "--verify", root, authenticated.keyId], { cwd: repository, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    const exitCode = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); });
    await writeFile(join(root, "independent-verifier.log"), output, { flag: "wx" }); report.independentExitCode = exitCode;
    report.independent = await json(join(root, "independent-verification.json")); assert.equal(exitCode, 0, JSON.stringify(report.independent)); assert.equal(report.independent.valid, true);
    report.passed = true;
  } catch (error) { report.error = error instanceof Error ? error.stack : String(error); }
  finally {
    if (service) await service.close(); else if (runtime) await runtime.close();
    try { await writeFile(join(root, "fixture-calls.json"), JSON.stringify(calls, null, 2), { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    report.implementationAfter = await snapshot(); report.implementationUnchanged = canonicalize(report.implementationAfter) === canonicalize(implementation);
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify({ root, passed: report.passed, caseId: report.caseId, verdict: report.verdict, implementationUnchanged: report.implementationUnchanged }));
  assert.ok(report.passed && report.implementationUnchanged, "Comparative repair proof failed; preserve and inspect every retained result");
}
