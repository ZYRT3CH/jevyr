import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { canonicalize, digestJson, isSha256Digest, sha256Digest, validateSealedCase, type JsonValue, type SealedCase } from "@jevyr/protocol";
import { parseJsonBytes } from "@jevyr/core";
import { candidateMaterializationDigest, candidateTreeDigest } from "./candidate-blueprints.js";
import type { ToolAdapter, ToolInvocation, ToolObservation } from "./contracts.js";
import { decodeExactByteCapture, encodeToolObservation } from "./evidence-artifacts.js";
import { SealedForgeAdapter, type DockerSubstrateIdentity } from "./forge.js";
import { sealedDockerForgeAuthority, verifyForgeExecutionAuthority } from "./forge-authority.js";
import { deriveRepositoryEvaluationClosure, materializeRepositoryEvaluationClosure, REPOSITORY_EVALUATION_CLOSURE_ROOT, type RepositoryEvaluationClosure } from "./repository-evaluation-closure.js";
import { checkRepositorySuiteReportConsistency, planRepositoryEvaluation, REPOSITORY_EVALUATION_DISCOVERY, REPOSITORY_EVALUATION_LIMITS, type RepositoryEvaluationPlan, type RepositoryEvaluatorRunner } from "./repository-evaluation-plan.js";
import { createRepositoryTestControllerRequest, type RepositoryTestControllerRequest } from "./repository-test-controller.js";
import type { SubjectContextReader } from "./subject-context.js";
import type { SubjectMaterialBinding } from "./subject-materials.js";
import { withQuarantinedMindWorkspace } from "./adapters/process-quarantine.js";

const json = (value: unknown) => value as JsonValue;
const hash = (value: unknown) => digestJson(json(value));
const bytes = (value: unknown) => Buffer.from(canonicalize(json(value)));
const equal = (a: unknown, b: unknown) => canonicalize(json(a)) === canonicalize(json(b));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => new TypeError("Repository diagnostic observer refused unsealed, changed, unavailable, or out-of-budget input");
const compare = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const require = createRequire(import.meta.url);
export const REPOSITORY_OBSERVER_CONTROLLER_PATH = "/subject/repository-evaluation/controller.mjs" as const;
export const REPOSITORY_OBSERVER_REQUEST_PATH = "/subject/repository-evaluation/request.json" as const;
// No shell and no submitted arguments. The parent remains outside the test child;
// all processes remain inside the same Forge container/resource envelope.
const BOOTSTRAP = `import {readFile} from 'node:fs/promises';import {spawn} from 'node:child_process';const input=await readFile('${REPOSITORY_OBSERVER_REQUEST_PATH}');if(input.length>1000000)throw Error('Controller request too large');const child=spawn(process.execPath,['${REPOSITORY_OBSERVER_CONTROLLER_PATH}'],{stdio:['pipe','inherit','inherit'],env:process.env});child.stdin.on('error',()=>{});child.stdin.end(input);await new Promise(resolve=>{child.on('error',()=>{process.stderr.write('Controller launch failed\\n');process.exitCode=2;resolve();});child.on('close',code=>{process.exitCode=Number.isInteger(code)?code:2;resolve();});});`;
export const REPOSITORY_OBSERVER_ARGV = Object.freeze(["--input-type=module", "--eval", BOOTSTRAP]);
export interface RepositoryEvaluationObserverPolicy {
  readonly protocol: "jevyr.repository-evaluator-factory/1";
  readonly discovery: typeof REPOSITORY_EVALUATION_DISCOVERY;
  readonly plannerImplementationDigest: string;
  readonly controllerSourceDigest: string;
  readonly controllerPath: typeof REPOSITORY_OBSERVER_CONTROLLER_PATH;
  readonly requestPath: typeof REPOSITORY_OBSERVER_REQUEST_PATH;
  readonly argv: readonly string[];
  readonly runner: RepositoryEvaluatorRunner;
  readonly limits: typeof REPOSITORY_EVALUATION_LIMITS;
  readonly controllerLimits: Readonly<{ timeoutMs: 28_000; maxEvents: 5_000; maxEventBytes: 250_000 }>;
  readonly maxSubjectsPerCase: 2;
  readonly timeoutMs: 30_000;
  readonly authority: "context-only";
}
const LOADED_CONTROLLER_BYTES = readFileSync(new URL("./repository-test-controller-runner.mjs", import.meta.url));
if (LOADED_CONTROLLER_BYTES.length > 128_000) throw fail();
// Private captured bytes serve both the mounted controller and consistency replay.
// Importing a data URL never runs its guarded stdin entrypoint or rereads source.
const LOADED_CONTROLLER_REPLAY = import(`data:text/javascript;base64,${LOADED_CONTROLLER_BYTES.toString("base64")}`);
function controllerSource(): Buffer { return Buffer.from(LOADED_CONTROLLER_BYTES); }
/** Source-mode and installed-mode identities are deliberately distinct. */
function loadImplementationDigest(): string {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const files = ["repository-evaluation-observer", "repository-evaluation-plan", "repository-evaluation-closure", "repository-test-controller"]
    .map(name => ({ name: `${name}.${extension}`, digest: sha256Digest(readFileSync(new URL(`./${name}.${extension}`, import.meta.url))) }));
  files.push({ name: "tree-sitter-javascript.wasm", digest: sha256Digest(readFileSync(require.resolve("tree-sitter-wasms/out/tree-sitter-javascript.wasm"))) });
  return hash({ protocol: "jevyr.repository-observer-implementation/1", files });
}
const LOADED_IMPLEMENTATION_DIGEST = loadImplementationDigest();
export function repositoryEvaluationObserverImplementationDigest(): string { return LOADED_IMPLEMENTATION_DIGEST; }
/** Startup-only descriptor; unresolved substrates do not offer this diagnostic. */
export function createRepositoryEvaluationObserverPolicy(input: { readonly dockerIdentity?: DockerSubstrateIdentity; readonly capabilityId?: string }): RepositoryEvaluationObserverPolicy | undefined {
  if (Object.keys(input).some(key => !["dockerIdentity", "capabilityId"].includes(key))) throw fail();
  const identity = input.dockerIdentity;
  if (!identity || identity.protocol !== "jevyr.docker-substrate-identity/1" || identity.status !== "resolved" || identity.failure !== null
    || !isSha256Digest(identity.immutableImageId) || identity.resolutionAuthority !== "local-docker-cli") return undefined;
  const capabilityId = input.capabilityId ?? "tool.forge.docker.v1";
  if (capabilityId !== "tool.forge.docker.v1") throw fail();
  const controllerSourceDigest = sha256Digest(controllerSource());
  return Object.freeze({ protocol: "jevyr.repository-evaluator-factory/1", discovery: REPOSITORY_EVALUATION_DISCOVERY,
    plannerImplementationDigest: repositoryEvaluationObserverImplementationDigest(), controllerSourceDigest,
    controllerPath: REPOSITORY_OBSERVER_CONTROLLER_PATH, requestPath: REPOSITORY_OBSERVER_REQUEST_PATH, argv: REPOSITORY_OBSERVER_ARGV,
    runner: Object.freeze({ id: "node-test-v1", evaluatorDigest: controllerSourceDigest, immutableImageId: identity.immutableImageId, capabilityId }),
    limits: REPOSITORY_EVALUATION_LIMITS, controllerLimits: Object.freeze({ timeoutMs: 28_000, maxEvents: 5_000, maxEventBytes: 250_000 }),
    maxSubjectsPerCase: 2, timeoutMs: 30_000, authority: "context-only" });
}
export function repositoryEvaluationObserverPolicyFromDescriptor(descriptor: unknown): RepositoryEvaluationObserverPolicy | undefined {
  try {
    const authority = sealedDockerForgeAuthority(descriptor);
    if (!authority.verified || !authority.authority || authority.authority.engine !== undefined || !object(descriptor) || !object(descriptor.policy)) return undefined;
    const selected = descriptor.policy.repositoryEvaluationObserver;
    const expected = createRepositoryEvaluationObserverPolicy({ dockerIdentity: { protocol: "jevyr.docker-substrate-identity/1", status: "resolved", failure: null,
      immutableImageId: authority.authority.immutableImageId, requestedReference: authority.authority.requestedReference, resolutionAuthority: authority.authority.resolutionAuthority } });
    return expected && equal(expected, selected) ? expected : undefined;
  } catch { return undefined; }
}
export function observerPlannerRunner(policy: RepositoryEvaluationObserverPolicy): RepositoryEvaluatorRunner { return policy.runner; }
export function repositoryObserverSubjectSelection(plan: RepositoryEvaluationPlan, policy: RepositoryEvaluationObserverPolicy): { readonly subjectIds: readonly string[]; readonly omittedSubjectIds: readonly string[] } {
  const ready = plan.subjects.filter(subject => subject.status === "ready" && subject.refusals.length === 0).map(subject => subject.subjectId).sort();
  return { subjectIds: ready.slice(0, policy.maxSubjectsPerCase), omittedSubjectIds: ready.slice(policy.maxSubjectsPerCase) };
}
/** Conservative public preflight; exact retained bytes are charged in the receipt. */
export function repositoryObserverMinimumArtifactBudget(plan: RepositoryEvaluationPlan): number { return 5_000_000 + bytes(plan).byteLength; }

export interface RepositoryEvaluationPackage {
  readonly protocol: "jevyr.repository-evaluation-package/1";
  readonly scope: "selected-closure-and-fixed-controller";
  readonly closureDigest: string;
  readonly controllerSourceDigest: string;
  readonly requestDigest: string;
  readonly entries: readonly ({ readonly path: string; readonly type: "directory" } | { readonly path: string; readonly type: "file"; readonly digest: string; readonly byteLength: number })[];
  readonly forgeTreeDigest: string;
  readonly byteLength: number;
  readonly digest: string;
}
/** Complete diagnostic mount identity, explicitly different from the Case capture. */
export function deriveRepositoryEvaluationPackage(closure: RepositoryEvaluationClosure, request: RepositoryTestControllerRequest, controllerBytes: Uint8Array): RepositoryEvaluationPackage {
  if (request.root !== REPOSITORY_EVALUATION_CLOSURE_ROOT || request.suiteDigest !== closure.suiteDigest || controllerBytes.byteLength > 128_000) throw fail();
  const requestBytes = bytes(request), controllerSourceDigest = sha256Digest(controllerBytes);
  const entries: RepositoryEvaluationPackage["entries"][number][] = [
    { path: "repository-evaluation", type: "directory" }, { path: "repository-evaluation/closure", type: "directory" },
    ...closure.directories.map(path => ({ path: `repository-evaluation/closure/${path}`, type: "directory" as const })),
    ...closure.files.map(file => ({ path: `repository-evaluation/closure/${file.path}`, type: "file" as const, digest: file.digest, byteLength: file.bytes })),
    { path: "repository-evaluation/controller.mjs", type: "file", digest: controllerSourceDigest, byteLength: controllerBytes.byteLength },
    { path: "repository-evaluation/request.json", type: "file", digest: sha256Digest(requestBytes), byteLength: requestBytes.length },
  ];
  entries.sort(compare);
  const body = { protocol: "jevyr.repository-evaluation-package/1" as const, scope: "selected-closure-and-fixed-controller" as const,
    closureDigest: closure.materializationDigest, controllerSourceDigest, requestDigest: hash(request), entries,
    forgeTreeDigest: hash({ protocol: "jevyr.directory-manifest/1", entries }), byteLength: entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.byteLength : 0), 0) };
  return { ...body, digest: hash(body) };
}
export interface RepositoryObserverResources {
  readonly wallMillis: number; readonly elapsedMeasurement: "HOST_MONOTONIC"; readonly executionAttempted: boolean; readonly cpuMillis: number | null;
  readonly cpuMeasurement: "MEASURED" | "UNMEASURED" | "NOT_ATTEMPTED";
  readonly writableBytes: number; readonly writableInodes: number;
  readonly workspaceMeasurement: "MEASURED" | "CONSERVATIVE_CEILING" | "NOT_ATTEMPTED";
  readonly artifactBytes: number;
}
export interface RepositoryObserverArtifact { readonly name: string; readonly digest: string; readonly byteLength: number; readonly mediaType: string }
export const REPOSITORY_OBSERVER_ARTIFACT_MEDIA = Object.freeze({
  planBytes: "application/vnd.jevyr.repository-evaluation-plan+json",
  closureBytes: "application/vnd.jevyr.repository-evaluation-closure+json",
  packageBytes: "application/vnd.jevyr.repository-evaluation-package+json",
  controllerSourceBytes: "application/vnd.jevyr.repository-observer-controller",
  requestBytes: "application/vnd.jevyr.repository-observer-request+json",
  outerForgeObservationBytes: "application/vnd.jevyr.tool-observation+json",
  controllerObservationBytes: "application/vnd.jevyr.repository-controller-observation+json",
  observerReceiptBytes: "application/vnd.jevyr.repository-observer-receipt+json",
});
export function repositoryObserverArtifactMediaType(key: string): string {
  if (!Object.hasOwn(REPOSITORY_OBSERVER_ARTIFACT_MEDIA, key)) throw fail();
  return REPOSITORY_OBSERVER_ARTIFACT_MEDIA[key as keyof typeof REPOSITORY_OBSERVER_ARTIFACT_MEDIA];
}
export interface RepositoryObserverInput {
  readonly sealedCase: SealedCase; readonly policyDescriptor: unknown; readonly plan: RepositoryEvaluationPlan; readonly subjectId: string;
  readonly bindings: readonly SubjectMaterialBinding[]; readonly reader: SubjectContextReader; readonly forge: ToolAdapter; readonly invocationId: string;
  readonly resourceLimits: NonNullable<ToolInvocation["resourceLimits"]>; readonly timeoutMs: number; readonly signal: AbortSignal;
}
export interface RepositoryObserverReceipt {
  readonly protocol: "jevyr.repository-evaluation-observer-receipt/1";
  readonly caseId: string; readonly runDigest: string; readonly policyDigest: string; readonly invocationId: string; readonly subjectId: string;
  readonly planDigest: string; readonly closureDigest: string; readonly packageDigest: string; readonly controllerSourceDigest: string; readonly requestDigest: string;
  readonly outerObservationDigest: string; readonly controllerObservationDigest: string | null;
  readonly target: "sealed-original-subject"; readonly scope: "selected-static-test-closure"; readonly workspaceRole: "empty-diagnostic-tooling";
  readonly authority: "none"; readonly reportOutcome: "pass" | "fail" | "unproven"; readonly controllerConsistent: boolean;
  readonly counts: Readonly<{ executedTests: number; passed: number; failed: number; errors: number; skipped: number; cancelled: number }> | null;
  readonly problems: readonly string[]; readonly resourceLimits: NonNullable<ToolInvocation["resourceLimits"]> & { readonly timeoutMs: number };
  /** Exact retained sidecars, excluding this receipt to avoid a digest cycle. */
  readonly artifacts: readonly RepositoryObserverArtifact[];
  readonly resources: RepositoryObserverResources;
}
export interface RepositoryObserverResult {
  readonly observation: ToolObservation; readonly receipt: RepositoryObserverReceipt;
  readonly artifacts: readonly { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array; readonly digest: string }[];
  readonly reportOutcome: RepositoryObserverReceipt["reportOutcome"];
  readonly resources: RepositoryObserverResources; readonly verdictAuthority: "none";
}
function resourceUse(observation: ToolObservation, limits: RepositoryObserverInput["resourceLimits"], wallMillis: number): Omit<RepositoryObserverResources, "artifactBytes"> {
  const accounting = observation.metadata?.resourceAccounting as any;
  const after = accounting?.workspace?.after;
  const measured = after?.measurement === "MEASURED" && after?.complete === true && Number.isSafeInteger(after.bytes) && after.bytes >= 0 && Number.isSafeInteger(after.inodes) && after.inodes >= 0;
  const attempted = accounting?.processOutput?.measurement === "MEASURED" || ["exited", "timed-out"].includes(observation.oracle?.execution?.state ?? "");
  const cpu = accounting?.cpu, cpuMeasured = attempted && cpu?.measurement === "MEASURED" && Number.isSafeInteger(cpu.usedMillis) && cpu.usedMillis >= 0;
  return { wallMillis, elapsedMeasurement: "HOST_MONOTONIC", executionAttempted: attempted, cpuMillis: cpuMeasured ? cpu.usedMillis : null,
    cpuMeasurement: !attempted ? "NOT_ATTEMPTED" : cpuMeasured ? "MEASURED" : "UNMEASURED",
    workspaceMeasurement: measured ? "MEASURED" : attempted ? "CONSERVATIVE_CEILING" : "NOT_ATTEMPTED",
    writableBytes: measured ? after.bytes : attempted ? limits.maxWritableBytes : 0,
    writableInodes: measured ? after.inodes : attempted ? limits.maxWritableInodes : 0 };
}
function distinctArtifactBytes(artifacts: Readonly<Record<string, Uint8Array>>): number {
  return [...new Map(Object.values(artifacts).map(value => [sha256Digest(value), value.byteLength])).values()].reduce((a, b) => a + b, 0);
}
async function writableForCleanup(root: string, identity: { readonly dev: number; readonly ino: number }): Promise<void> {
  const current = await lstat(root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw fail();
  let entries = 0;
  const visit = async (path: string): Promise<void> => {
    if (++entries > 2048) throw fail();
    const stat = await lstat(path); if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile()) || stat.isFile() && stat.nlink !== 1) throw fail();
    await chmod(path, 0o700);
    if (stat.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(root);
}

/** Diagnostic only: never emits population/evidence events and never grants a verdict edge. */
export async function observeRepositoryEvaluation(input: RepositoryObserverInput): Promise<RepositoryObserverResult> {
  const started = performance.now();
  const checked = validateSealedCase(input.sealedCase);
  const policy = repositoryEvaluationObserverPolicyFromDescriptor(input.policyDescriptor), authority = sealedDockerForgeAuthority(input.policyDescriptor);
  if (!checked.ok || !checked.value || hash(input.policyDescriptor) !== checked.value.policyDigest || !policy || !authority.authority
    || SealedForgeAdapter.liveAuthorityProblem(input.forge, authority.authority) || input.forge.capability.network !== "none"
    || !/^[A-Za-z0-9._-]{1,256}$/u.test(input.invocationId) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > policy.timeoutMs) throw fail();
  const sealed = checked.value;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]);
  for (const key of ["maxWritableBytes", "maxWritableInodes", "maxArtifactBytes"] as const)
    if (!Number.isSafeInteger(input.resourceLimits[key]) || input.resourceLimits[key] < 1) throw fail();
  if (Object.keys(input.resourceLimits).some(key => !["maxWritableBytes", "maxWritableInodes", "maxArtifactBytes"].includes(key))) throw fail();
  signal.throwIfAborted();
  const captureDigest = sealed.subjectMaterialCaptureDigest;
  if (input.bindings.length !== sealed.subjects.length || input.bindings.some(binding => !sealed.subjects.some(subject => subject.subjectId === binding.subjectId && subject.digest === binding.subjectDigest))) throw fail();
  const plan = await planRepositoryEvaluation({ captureDigest, bindings: input.bindings, reader: input.reader, contract: sealed.intentContract, runner: policy.runner, limits: policy.limits });
  if (!equal(plan, input.plan)) throw fail();
  const eligible = plan.subjects.filter(subject => subject.status === "ready" && subject.refusals.length === 0).sort((a, b) => a.subjectId < b.subjectId ? -1 : 1).slice(0, policy.maxSubjectsPerCase);
  const subject = eligible.find(item => item.subjectId === input.subjectId); if (!subject) throw fail();
  const closureInput = { captureDigest, bindings: input.bindings, reader: input.reader, subject };
  const closure = await deriveRepositoryEvaluationClosure(closureInput), request = createRepositoryTestControllerRequest(subject, REPOSITORY_EVALUATION_CLOSURE_ROOT, policy.controllerLimits);
  const controllerBytes = controllerSource(); if (sha256Digest(controllerBytes) !== policy.controllerSourceDigest) throw fail();
  const packaged = deriveRepositoryEvaluationPackage(closure, request, controllerBytes);
  const artifacts: Record<string, Uint8Array> = { planBytes: bytes(plan), closureBytes: bytes(closure), packageBytes: bytes(packaged), controllerSourceBytes: controllerBytes, requestBytes: bytes(request) };
  // Reserve enough space for the outer exact captures (base64), controller copy,
  // and bounded receipt. No diagnostic may bypass the Case artifact remainder.
  if (distinctArtifactBytes(artifacts) + policy.controllerLimits.maxEventBytes * 5 + 32_000 > input.resourceLimits.maxArtifactBytes) throw fail();
  const observation = await withQuarantinedMindWorkspace(async temporary => {
    const temporaryIdentity = await lstat(temporary);
    try {
      const subjectRoot = join(temporary, "subject"), toolingRoot = join(temporary, "tooling"); await mkdir(subjectRoot); await mkdir(toolingRoot);
      const packageRoot = join(subjectRoot, "repository-evaluation"); await mkdir(packageRoot);
      const materialized = await materializeRepositoryEvaluationClosure(closureInput, join(packageRoot, "closure"));
      if (!equal(materialized.descriptor, closure)) throw fail();
      await writeFile(join(packageRoot, "controller.mjs"), controllerBytes, { flag: "wx", mode: 0o444 });
      await writeFile(join(packageRoot, "request.json"), artifacts.requestBytes!, { flag: "wx", mode: 0o444 });
      await chmod(packageRoot, 0o555); await chmod(subjectRoot, 0o555);
      const emptyToolingDigest = hash({ protocol: "jevyr.repository-observer-empty-tooling/1", role: "empty-diagnostic-tooling" });
      signal.throwIfAborted();
      const remaining = Math.floor(input.timeoutMs - (performance.now() - started)); if (remaining < 1) throw fail();
      return await input.forge.execute({ invocationId: input.invocationId, caseId: sealed.caseId, tool: "forge.command", args: { command: "node", args: policy.argv }, timeoutMs: remaining,
        resourceLimits: input.resourceLimits, signal, forgeMaterials: { protocol: "jevyr.forge-invocation-materials/1",
          candidate: { sourceRoot: toolingRoot, blueprintDigest: emptyToolingDigest, materializationDigest: candidateMaterializationDigest(emptyToolingDigest, []), treeDigest: candidateTreeDigest([]) },
          subjects: { subjectRoot, captureDigest: packaged.digest, materializationDigest: packaged.digest } } });
    } finally { await writableForCleanup(temporary, temporaryIdentity); }
  });
  const outerBytes = encodeToolObservation(observation).bytes; artifacts.outerForgeObservationBytes = outerBytes;
  let reportOutcome: RepositoryObserverReceipt["reportOutcome"] = "unproven", controllerConsistent = false, counts: RepositoryObserverReceipt["counts"] = null;
  const problems = new Set<string>();
  let controllerObservationDigest: string | null = null;
  try {
    const execution = observation.oracle?.execution, boundary = observation.oracle?.subjectBoundary;
    if (!observation.oracle || !verifyForgeExecutionAuthority(input.policyDescriptor, observation.oracle).verified || !execution || execution.state !== "exited" || execution.exitCode !== 0
      || execution.command !== "node" || !equal(execution.args, policy.argv) || execution.outputTruncated !== false
      || !boundary || !boundary.complete || !boundary.sealedSubjectReadOnly || boundary.originalSubjectAccessible
      || boundary.captureDigest !== packaged.digest || boundary.materializationDigest !== packaged.digest || boundary.beforeDigest !== packaged.forgeTreeDigest || boundary.afterDigest !== packaged.forgeTreeDigest) throw Error("OUTER_EXECUTION_INCOMPLETE");
    const stdout = decodeExactByteCapture(execution.stdoutCapture), stderr = decodeExactByteCapture(execution.stderrCapture);
    artifacts.controllerObservationBytes = Buffer.from(stdout.bytes); controllerObservationDigest = sha256Digest(stdout.bytes);
    if (execution.stdoutCapture?.complete !== true || execution.stderrCapture?.complete !== true || stderr.bytes.length !== 0) throw Error("CONTROLLER_OUTPUT_INCOMPLETE");
    const controller = parseJsonBytes(stdout.bytes, "repository controller") as any;
    if (!Buffer.from(stdout.bytes).equals(Buffer.concat([bytes(controller), Buffer.from("\n")])) || controller.protocol !== "jevyr.repository-suite-controller-observation/1"
      || controller.authority !== "none" || controller.requestDigest !== hash(request) || controller.target !== request.target || controller.runner !== "node:test.run/process"
      || typeof controller.nodeVersion !== "string" || !/^v24\.[0-9]+\.[0-9]+$/u.test(controller.nodeVersion)
      || !Array.isArray(controller.events) || controller.eventDigest !== hash(controller.events)) throw Error("CONTROLLER_OUTPUT_INVALID");
    const { digest, ...body } = controller; if (digest !== hash(body)) throw Error("CONTROLLER_OUTPUT_INVALID");
    const replay = (await LOADED_CONTROLLER_REPLAY).summarizeRepositoryTestEvents(controller.events, request, controller.stream, controller.inventory);
    if (!equal(replay.report, controller.report) || !equal(replay.problems, controller.problems)) throw Error("CONTROLLER_OUTPUT_INVALID");
    const consistency = checkRepositorySuiteReportConsistency(replay.report, subject.suiteDigest);
    controllerConsistent = consistency.consistent && replay.problems.length === 0;
    reportOutcome = controllerConsistent ? consistency.outcome : "unproven";
    const { executedTests, passed, failed, errors, skipped, cancelled } = replay.report; counts = { executedTests, passed, failed, errors, skipped, cancelled };
    for (const problem of replay.problems) problems.add(problem);
  } catch (error) { problems.add(error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message) ? error.message : "CONTROLLER_REPLAY_REFUSED"); }
  problems.add("DIAGNOSTIC_ONLY_NO_VERDICT_AUTHORITY");
  const inventory = Object.entries(artifacts).map(([name, value]) => ({ name, digest: sha256Digest(value), byteLength: value.byteLength, mediaType: repositoryObserverArtifactMediaType(name) })).sort((a, b) => a.name < b.name ? -1 : 1);
  const base = { protocol: "jevyr.repository-evaluation-observer-receipt/1" as const, caseId: sealed.caseId, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest,
    invocationId: input.invocationId, subjectId: subject.subjectId, planDigest: plan.digest, closureDigest: closure.materializationDigest, packageDigest: packaged.digest,
    controllerSourceDigest: policy.controllerSourceDigest, requestDigest: hash(request), outerObservationDigest: sha256Digest(outerBytes), controllerObservationDigest,
    target: "sealed-original-subject" as const, scope: "selected-static-test-closure" as const, workspaceRole: "empty-diagnostic-tooling" as const, authority: "none" as const,
    reportOutcome, controllerConsistent, counts, problems: [...problems].sort(), artifacts: inventory, resourceLimits: { ...input.resourceLimits, timeoutMs: input.timeoutMs } };
  const measured = resourceUse(observation, input.resourceLimits, Math.ceil(performance.now() - started));
  let receipt: RepositoryObserverReceipt = { ...base, resources: { ...measured, artifactBytes: 0 } };
  for (let i = 0; i < 8; i++) {
    artifacts.observerReceiptBytes = bytes(receipt);
    const artifactBytes = distinctArtifactBytes(artifacts);
    if (artifactBytes === receipt.resources.artifactBytes) break;
    receipt = { ...base, resources: { ...measured, artifactBytes } };
  }
  artifacts.observerReceiptBytes = bytes(receipt);
  if (distinctArtifactBytes(artifacts) !== receipt.resources.artifactBytes || receipt.resources.artifactBytes > input.resourceLimits.maxArtifactBytes) throw fail();
  return { observation, receipt, artifacts: Object.entries(artifacts).map(([name, value]) => ({ name, mediaType: repositoryObserverArtifactMediaType(name), bytes: value, digest: sha256Digest(value) })).sort((a, b) => a.name < b.name ? -1 : 1), reportOutcome, resources: receipt.resources, verdictAuthority: "none" };
}
