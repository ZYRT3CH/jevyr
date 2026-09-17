import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { decodeDsseJson, sealReceipt, SEAL_DSSE_PAYLOAD_TYPE, verifyDsse } from "@jevyr/core";
import { canonicalize, digestJson, isSha256Digest, sha256Digest, validateSealedCase, type DsseEnvelope, type JsonValue, type SealedCase } from "@jevyr/protocol";
import { SealedForgeAdapter, FORGE_LIMIT_DEFAULTS, type DockerSubstrateIdentity } from "./forge.js";
import { sealedDockerForgeAuthority, verifyForgeExecutionAuthority } from "./forge-authority.js";
import { decodeExactByteCapture, decodeToolObservation, encodeToolObservation } from "./evidence-artifacts.js";
import { withQuarantinedMindWorkspace } from "./adapters/process-quarantine.js";
import { REPOSITORY_PURE_ASSERTION_LIMITS, type RepositoryPureAssertionLimits, type RepositoryPureAssertionAnalysis, type RepositoryPureAssertionInput } from "./repository-pure-assertions.js";
import { assertRepositoryPureProducerAssets, createRepositoryPureProducerAssets, prepareRepositoryPureProducerPackage, materializeRepositoryPureProducerPackage } from "./repository-pure-producer.js";
import type { ToolAdapter, ToolInvocation, ToolObservation } from "./contracts.js";

/** Physical certificate preparation. No Record/event integration or verdict
 * edges are supplied by this module; a valid replay still has authority:none. */
type Assets = Awaited<ReturnType<typeof createRepositoryPureProducerAssets>>;
type Prepared = Awaited<ReturnType<typeof prepareRepositoryPureProducerPackage>>;
type Limits = NonNullable<ToolInvocation["resourceLimits"]>;
const hash = (value: unknown) => digestJson(value as JsonValue);
const encoded = (value: unknown) => Buffer.from(canonicalize(value as JsonValue));
const same = (left: unknown, right: unknown) => canonicalize(left as JsonValue) === canonicalize(right as JsonValue);
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function refuse(code: string): never { throw new Error(code); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
// Pin the physical wrapper separately from the producer/parser implementation.
const IMPLEMENTATION_DIGEST = sha256Digest(readFileSync(new URL(import.meta.url)));
export interface RepositoryPureExecutionPolicy {
  readonly protocol: "jevyr.repository-pure-execution-factory/1";
  readonly purpose: "original-captured-assertion-evaluation";
  readonly producerImplementationDigest: string;
  readonly executionImplementationDigest: string;
  readonly entryPath: string;
  readonly requestPath: string;
  readonly argv: readonly string[];
  readonly runner: RepositoryPureAssertionInput["runner"];
  readonly limits: RepositoryPureAssertionLimits;
  readonly timeoutMs: 30_000;
  readonly maximumOutputBytes: 1_000_000;
}
export function createRepositoryPureExecutionPolicy(assets: Assets, identity: DockerSubstrateIdentity): RepositoryPureExecutionPolicy {
  assertRepositoryPureProducerAssets(assets);
  if (identity.protocol !== "jevyr.docker-substrate-identity/1" || identity.status !== "resolved" || identity.failure !== null
    || identity.resolutionAuthority !== "local-docker-cli" || !isSha256Digest(identity.immutableImageId)) refuse("PURE_SUBSTRATE_UNAVAILABLE");
  return Object.freeze({ protocol: "jevyr.repository-pure-execution-factory/1", purpose: "original-captured-assertion-evaluation",
    producerImplementationDigest: assets.descriptor.digest, executionImplementationDigest: IMPLEMENTATION_DIGEST,
    entryPath: assets.descriptor.entryPath, requestPath: assets.descriptor.requestPath, argv: Object.freeze([...assets.descriptor.argv]),
    runner: Object.freeze({ id: "node-test-v1", evaluatorDigest: assets.descriptor.digest, immutableImageId: identity.immutableImageId, capabilityId: "tool.forge.docker.v1" }),
    // Analysis reserves headroom for its result wrapper and exact Forge captures.
    limits: Object.freeze({ ...REPOSITORY_PURE_ASSERTION_LIMITS, maxCertificateBytes: 500_000 }), timeoutMs: 30_000, maximumOutputBytes: 1_000_000 });
}
function policyFor(descriptor: unknown, assets: Assets): RepositoryPureExecutionPolicy {
  const authority = sealedDockerForgeAuthority(descriptor).authority;
  if (!authority || authority.engine !== undefined || !object(descriptor) || !object(descriptor.policy)
    || descriptor.policy.effectiveForgeConfig?.allowNetwork === true) refuse("PURE_FACTORY_UNAVAILABLE");
  const expected = createRepositoryPureExecutionPolicy(assets, { protocol: "jevyr.docker-substrate-identity/1", status: "resolved", failure: null,
    requestedReference: authority.requestedReference, immutableImageId: authority.immutableImageId, resolutionAuthority: authority.resolutionAuthority });
  if (!same(expected, descriptor.policy.repositoryPureAssertions)) refuse("PURE_FACTORY_MISMATCH");
  return expected;
}
function withinSealedEnvelope(sealed: SealedCase, limits: Limits, timeoutMs: number): void {
  const maximum = sealed.searchEnvelope.profile.resources;
  if (maximum.maxForgeCpuMillis < 1 || timeoutMs > Math.min(maximum.maxForgeWallMillis, maximum.maxWallMillis, maximum.maxSingleInvocationMillis)
    || limits.maxWritableBytes > maximum.maxWritableBytes || limits.maxWritableInodes > maximum.maxWritableInodes || limits.maxArtifactBytes > maximum.maxArtifactBytes)
    refuse("PURE_SEALED_RESOURCE_ENVELOPE_EXCEEDED");
}
export interface RepositoryPureExecutionInput {
  readonly sealedCase: SealedCase;
  readonly policyDescriptor: unknown;
  readonly assets: Assets;
  readonly bindings: RepositoryPureAssertionInput["bindings"];
  readonly reader: RepositoryPureAssertionInput["reader"];
  readonly forge: ToolAdapter;
  readonly invocationId: string;
  readonly resourceLimits: Limits;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}
export interface RepositoryPureResources {
  readonly wallMillis: number;
  readonly elapsedMeasurement: "HOST_MONOTONIC";
  readonly executionAttempted: boolean;
  readonly cpuMillis: number | null;
  readonly cpuMeasurement: "MEASURED" | "UNMEASURED" | "NOT_ATTEMPTED";
  readonly writableBytes: number;
  readonly writableInodes: number;
  readonly workspaceMeasurement: "MEASURED" | "CONSERVATIVE_CEILING" | "NOT_ATTEMPTED";
  readonly artifactBytes: number;
}
export interface RepositoryPureExecutionReceipt {
  readonly protocol: "jevyr.repository-pure-execution-receipt/1";
  readonly caseId: string; readonly caseDigest: string; readonly runDigest: string; readonly policyDigest: string;
  readonly invocationId: string; readonly packageDigest: string; readonly implementationDigest: string; readonly requestDigest: string;
  readonly target: "sealed-original-subject"; readonly workspaceRole: "empty-tooling"; readonly authority: "none";
  readonly outerObservationDigest: string; readonly resultDigest: string | null;
  readonly resourceLimits: Limits & { readonly timeoutMs: number };
  readonly resources: RepositoryPureResources;
  readonly artifacts: readonly Readonly<{ name: string; digest: string; byteLength: number }>[];
}
const sumBytes = (artifacts: Readonly<Record<string, Uint8Array>>) => [...new Map(Object.values(artifacts).map(bytes => [sha256Digest(bytes), bytes.length])).values()].reduce((a, b) => a + b, 0);
function resources(observation: ToolObservation, limits: Limits, wallMillis: number): Omit<RepositoryPureResources, "artifactBytes"> {
  const accounting = observation.metadata?.resourceAccounting as any, after = accounting?.workspace?.after;
  const attempted = accounting?.processOutput?.measurement === "MEASURED" || ["exited", "timed-out"].includes(observation.oracle?.execution.state ?? "");
  const measured = after?.measurement === "MEASURED" && after.complete === true && natural(after.bytes) && natural(after.inodes);
  const cpu = accounting?.cpu, cpuMeasured = attempted && cpu?.measurement === "MEASURED" && natural(cpu.usedMillis);
  return { wallMillis, elapsedMeasurement: "HOST_MONOTONIC", executionAttempted: attempted, cpuMillis: cpuMeasured ? cpu.usedMillis : null,
    cpuMeasurement: !attempted ? "NOT_ATTEMPTED" : cpuMeasured ? "MEASURED" : "UNMEASURED", writableBytes: measured ? after.bytes : attempted ? limits.maxWritableBytes : 0,
    writableInodes: measured ? after.inodes : attempted ? limits.maxWritableInodes : 0, workspaceMeasurement: measured ? "MEASURED" : attempted ? "CONSERVATIVE_CEILING" : "NOT_ATTEMPTED" };
}
async function cleanupWritable(root: string, identity: { dev: number; ino: number }): Promise<void> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) refuse("PURE_CLEANUP_ROOT_REPLACED");
  let count = 0;
  const visit = async (path: string): Promise<void> => {
    if (++count > 2048) refuse("PURE_CLEANUP_INVENTORY_LIMIT");
    const info = await lstat(path);
    if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile()) || info.isFile() && info.nlink !== 1) refuse("PURE_CLEANUP_ENTRY_REPLACED");
    await chmod(path, 0o700); if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(root);
}
function packageArtifacts(prepared: Prepared, assets: Assets): Record<string, Uint8Array> {
  return Object.fromEntries([
    ["package.json", encoded(prepared.descriptor)], ["implementation.json", encoded(assets.descriptor)],
    ...prepared.files().map(file => [`mount/${file.path}`, Buffer.from(file.bytes)] as const),
  ]);
}
export async function executeRepositoryPureAssertions(input: RepositoryPureExecutionInput): Promise<Readonly<{
  authority: "none"; receipt: RepositoryPureExecutionReceipt; observation: ToolObservation; artifacts: Readonly<Record<string, Uint8Array>>;
}>> {
  const started = performance.now(), policy = policyFor(input.policyDescriptor, input.assets), checked = validateSealedCase(input.sealedCase);
  const authority = sealedDockerForgeAuthority(input.policyDescriptor).authority;
  if (!checked.ok || !checked.value || hash(input.policyDescriptor) !== checked.value.policyDigest || !authority
    || SealedForgeAdapter.liveAuthorityProblem(input.forge, authority) || input.forge.capability.network !== "none"
    || !/^[A-Za-z0-9._-]{1,256}$/u.test(input.invocationId) || !natural(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > policy.timeoutMs
    || !exact(input.resourceLimits, ["maxWritableBytes", "maxWritableInodes", "maxArtifactBytes"])
    || Object.values(input.resourceLimits).some(value => !natural(value) || value < 1)) refuse("PURE_EXECUTION_INPUT_REFUSED");
  const sealed = checked.value, signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]);
  withinSealedEnvelope(sealed, input.resourceLimits, input.timeoutMs); signal.throwIfAborted();
  const prepared = await prepareRepositoryPureProducerPackage({ sealedCase: sealed, bindings: input.bindings, reader: input.reader, runner: policy.runner, limits: policy.limits }, input.assets);
  const artifacts = packageArtifacts(prepared, input.assets);
  if (sumBytes(artifacts) + 4_000_000 > input.resourceLimits.maxArtifactBytes) refuse("PURE_ARTIFACT_ENVELOPE_EXHAUSTED");
  const observation = await withQuarantinedMindWorkspace(async temporary => {
    const identity = await lstat(temporary);
    try {
      const subjectRoot = join(temporary, "subject"), sourceRoot = join(temporary, "scratch"); await mkdir(sourceRoot);
      const mounted = await materializeRepositoryPureProducerPackage(prepared, subjectRoot);
      if (!same(mounted, prepared.descriptor)) refuse("PURE_MATERIALIZATION_MISMATCH");
      signal.throwIfAborted(); const remaining = Math.floor(input.timeoutMs - (performance.now() - started)); if (remaining < 1) refuse("PURE_DEADLINE_EXHAUSTED");
      return await input.forge.execute({ invocationId: input.invocationId, caseId: sealed.caseId, tool: "forge.command", args: { command: "node", args: policy.argv },
        timeoutMs: remaining, resourceLimits: input.resourceLimits, signal, forgeMaterials: { protocol: "jevyr.forge-invocation-materials/2",
          workspace: { role: "empty-tooling", sourceRoot }, subjects: { subjectRoot, captureDigest: prepared.descriptor.digest, materializationDigest: prepared.descriptor.digest } } });
    } finally { await cleanupWritable(temporary, identity); }
  });
  artifacts["observation.json"] = encodeToolObservation(observation).bytes;
  const execution = observation.oracle?.execution;
  if (execution?.stdoutCapture) artifacts["result.json"] = Buffer.from(decodeExactByteCapture(execution.stdoutCapture).bytes);
  const base = { protocol: "jevyr.repository-pure-execution-receipt/1" as const, caseId: sealed.caseId, caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest,
    invocationId: input.invocationId, packageDigest: prepared.descriptor.digest, implementationDigest: input.assets.descriptor.digest, requestDigest: hash(prepared.request),
    target: "sealed-original-subject" as const, workspaceRole: "empty-tooling" as const, authority: "none" as const,
    outerObservationDigest: sha256Digest(artifacts["observation.json"]!), resultDigest: artifacts["result.json"] ? sha256Digest(artifacts["result.json"]!) : null,
    resourceLimits: { ...input.resourceLimits, timeoutMs: input.timeoutMs }, artifacts: Object.entries(artifacts).map(([name, data]) => ({ name, digest: sha256Digest(data), byteLength: data.length })).sort((a, b) => a.name < b.name ? -1 : 1) };
  const readings = resources(observation, input.resourceLimits, Math.ceil(performance.now() - started));
  let receipt: RepositoryPureExecutionReceipt = { ...base, resources: { ...readings, artifactBytes: 0 } };
  for (let i = 0; i < 8; i++) {
    artifacts["receipt.json"] = encoded(receipt); const used = sumBytes(artifacts); if (receipt.resources.artifactBytes === used) break;
    receipt = { ...base, resources: { ...readings, artifactBytes: used } };
  }
  artifacts["receipt.json"] = encoded(receipt);
  if (sumBytes(artifacts) !== receipt.resources.artifactBytes || receipt.resources.artifactBytes > input.resourceLimits.maxArtifactBytes) refuse("PURE_ARTIFACT_ENVELOPE_EXHAUSTED");
  return { authority: "none", receipt, observation, artifacts };
}

export interface RepositoryPureExecutionReplayInput {
  /** Trusted by the verifier host. Never populate from the claimed proof alone. */
  readonly trustedCaseKeys: ReadonlyMap<string, string>;
  readonly sealedCase: unknown;
  readonly sealEnvelope: unknown;
  readonly policyDescriptor: unknown;
  readonly assets: Assets;
  readonly bindings: RepositoryPureAssertionInput["bindings"];
  readonly reader: RepositoryPureAssertionInput["reader"];
  readonly artifacts: Readonly<Record<string, Uint8Array>>;
}
/** Independently rederive every source expression and complete package before
 * comparing physical captures. This does not authenticate a Record event join. */
export async function replayRepositoryPureExecution(input: RepositoryPureExecutionReplayInput): Promise<Readonly<{
  authority: "none"; authenticatedCase: boolean; consistent: boolean; outcome: RepositoryPureAssertionAnalysis["outcome"]; problems: readonly string[];
}>> {
  let authenticatedCase = false, outcome: RepositoryPureAssertionAnalysis["outcome"] = "unavailable";
  try {
    const checked = validateSealedCase(input.sealedCase), envelope = input.sealEnvelope;
    if (!checked.ok || !checked.value || !input.trustedCaseKeys.size || !object(envelope) || envelope.payloadType !== SEAL_DSSE_PAYLOAD_TYPE
      || typeof envelope.payload !== "string" || envelope.payload.length > 4_000_000 || !Array.isArray(envelope.signatures) || envelope.signatures.length > 16
      || !verifyDsse(envelope as DsseEnvelope, input.trustedCaseKeys) || !same(decodeDsseJson(envelope as DsseEnvelope), sealReceipt(checked.value))
      || !Buffer.from(envelope.payload, "base64").equals(encoded(sealReceipt(checked.value)))) refuse("PURE_SEAL_AUTHENTICATION_FAILED");
    authenticatedCase = true; const sealed = checked.value, policy = policyFor(input.policyDescriptor, input.assets);
    if (hash(input.policyDescriptor) !== sealed.policyDigest) refuse("PURE_POLICY_BINDING_MISMATCH");
    const prepared = await prepareRepositoryPureProducerPackage({ sealedCase: sealed, bindings: input.bindings, reader: input.reader, runner: policy.runner, limits: policy.limits }, input.assets);
    const required = packageArtifacts(prepared, input.assets), artifacts = input.artifacts;
    if (!exact(artifacts, [...Object.keys(required), "observation.json", "result.json", "receipt.json"])) refuse("PURE_SIDECAR_MEMBERSHIP_MISMATCH");
    for (const [name, bytes] of Object.entries(required)) if (!(artifacts[name] instanceof Uint8Array) || !Buffer.from(artifacts[name]!).equals(Buffer.from(bytes))) refuse("PURE_PACKAGE_RECONSTRUCTION_MISMATCH");
    const observation = decodeToolObservation(artifacts["observation.json"]!), oracle = observation.oracle, execution = oracle?.execution;
    if (!oracle || !verifyForgeExecutionAuthority(input.policyDescriptor, oracle).verified || execution?.state !== "exited" || execution.exitCode !== 0
      || execution.mode !== "docker" || execution.command !== "node" || execution.shell !== false || !same(execution.args, policy.argv)
      || execution.outputTruncated !== false || execution.stdoutCapture?.complete !== true || execution.stderrCapture?.complete !== true
      || observation.status !== "succeeded" || observation.exitCode !== 0 || (observation.artifactRefs?.length ?? 0) !== 0
      || observation.metadata?.admissible !== true || observation.metadata.mode !== "docker" || observation.metadata.command !== "node"
      || !same(observation.metadata.args, policy.argv) || observation.metadata.shell !== false || observation.metadata.sourceReadOnly !== true
      || observation.metadata.sourceSanitized !== true || observation.metadata.networkDenied !== true
      || observation.metadata.originalSourceIsolation !== "ENFORCED_BY_EXCLUSIVE_MOUNTS") refuse("PURE_PHYSICAL_EXECUTION_INCOMPLETE");
    if (!same(oracle.toolingWorkspace, { schema: "jevyr.empty-tooling-workspace/1", initialEntries: 0, initialDigest: hash({ protocol: "jevyr.directory-manifest/1", entries: [] }) })
      || !same(oracle.subjectBoundary, { schema: "jevyr.sanitized-subject-boundary/2", sanitized: true, disposableWorkspace: true, sealedSubjectReadOnly: true,
        originalSubjectAccessible: false, complete: true, captureDigest: prepared.descriptor.digest, materializationDigest: prepared.descriptor.digest,
        beforeDigest: prepared.descriptor.forgeTreeDigest, afterDigest: prepared.descriptor.forgeTreeDigest })
      || !same(oracle.networkIsolation, { schema: "jevyr.docker-network-none/1", networkMode: "none", enforced: true, complete: true, externalAccessCount: 0 })
      || !oracle.workspace?.complete || oracle.workspace.entries.length !== 0) refuse("PURE_PHYSICAL_BOUNDARY_MISMATCH");
    const stdout = decodeExactByteCapture(execution.stdoutCapture), stderr = decodeExactByteCapture(execution.stderrCapture);
    const expectedOutput = Buffer.concat([encoded(prepared.expectedResult), Buffer.from("\n")]);
    if (stderr.bytes.length !== 0 || !Buffer.from(stdout.bytes).equals(expectedOutput) || !Buffer.from(artifacts["result.json"]!).equals(expectedOutput)) refuse("PURE_CERTIFICATE_RECONSTRUCTION_MISMATCH");
    const rawReceipt = artifacts["receipt.json"]!;
    if (!(rawReceipt instanceof Uint8Array) || rawReceipt.length > 1_000_000) refuse("PURE_RECEIPT_MISSING");
    const receipt = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(rawReceipt)) as RepositoryPureExecutionReceipt;
    if (!Buffer.from(rawReceipt).equals(encoded(receipt)) || !exact(receipt, ["protocol", "caseId", "caseDigest", "runDigest", "policyDigest", "invocationId", "packageDigest", "implementationDigest", "requestDigest",
      "target", "workspaceRole", "authority", "outerObservationDigest", "resultDigest", "resourceLimits", "resources", "artifacts"])) refuse("PURE_RECEIPT_SHAPE_MISMATCH");
    const fixed = { protocol: "jevyr.repository-pure-execution-receipt/1", caseId: sealed.caseId, caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest,
      invocationId: observation.invocationId, packageDigest: prepared.descriptor.digest, implementationDigest: input.assets.descriptor.digest, requestDigest: hash(prepared.request), target: "sealed-original-subject", workspaceRole: "empty-tooling", authority: "none",
      outerObservationDigest: sha256Digest(artifacts["observation.json"]!), resultDigest: sha256Digest(artifacts["result.json"]!) };
    for (const [key, value] of Object.entries(fixed)) if (!same((receipt as any)[key], value)) refuse("PURE_RECEIPT_BINDING_MISMATCH");
    if (!exact(receipt.resourceLimits, ["maxWritableBytes", "maxWritableInodes", "maxArtifactBytes", "timeoutMs"]) || Object.values(receipt.resourceLimits).some(value => !natural(value) || value < 1)
      || receipt.resourceLimits.timeoutMs < 100 || receipt.resourceLimits.timeoutMs > policy.timeoutMs || !natural(receipt.resources?.wallMillis)) refuse("PURE_RECEIPT_LIMIT_MISMATCH");
    withinSealedEnvelope(sealed, receipt.resourceLimits, receipt.resourceLimits.timeoutMs);
    if (receipt.resources.wallMillis > Math.min(sealed.searchEnvelope.profile.resources.maxForgeWallMillis, sealed.searchEnvelope.profile.resources.maxWallMillis)) refuse("PURE_SEALED_RESOURCE_ENVELOPE_EXCEEDED");
    const inventory = Object.entries(artifacts).filter(([name]) => name !== "receipt.json").map(([name, data]) => ({ name, digest: sha256Digest(data), byteLength: data.length })).sort((a, b) => a.name < b.name ? -1 : 1);
    if (!same(receipt.artifacts, inventory) || !same(receipt.resources, { ...resources(observation, receipt.resourceLimits, receipt.resources.wallMillis), artifactBytes: sumBytes(artifacts) })
      || receipt.resources.artifactBytes > receipt.resourceLimits.maxArtifactBytes) refuse("PURE_RESOURCE_RECEIPT_MISMATCH");
    const accounting = observation.metadata?.resourceAccounting as any, config = (input.policyDescriptor as any).policy.effectiveForgeConfig;
    const outputCeiling = config.maxProcessOutputBytes ?? FORGE_LIMIT_DEFAULTS.maxProcessOutputBytes;
    const emptyRuntime = { measurement: "MEASURED", complete: true, bytes: 0, inodes: 5, files: 0, directories: 5,
      digest: hash({ protocol: "jevyr.directory-manifest/1", entries: ["runtime", "runtime/home", "runtime/shm", "runtime/tmp", "work"].map(path => ({ path, type: "directory" })) }) };
    if (accounting?.protocol !== "jevyr.forge-resource-accounting/1" || accounting.wall?.measurement !== "MEASURED"
      || typeof accounting.wall.usedMillis !== "number" || !Number.isFinite(accounting.wall.usedMillis) || accounting.wall.usedMillis < 0 || accounting.wall.usedMillis > receipt.resources.wallMillis
      || accounting.cpu?.measurement !== "DECLARED_ONLY" || accounting.cpu.usedMillis !== null || accounting.cpu.enforcement !== "RATE_ONLY_NOT_TOTAL_CPU"
      || accounting.cpu.rateLimitCpus !== (config.cpus ?? 2)
      || accounting.processOutput?.measurement !== "MEASURED" || accounting.processOutput.complete !== true || accounting.processOutput.exactCapturesComplete !== true
      || accounting.processOutput.ceilingBytes !== outputCeiling || accounting.processOutput.usedBytes !== stdout.bytes.length || accounting.processOutput.stdoutBytes !== stdout.bytes.length
      || accounting.processOutput.stderrBytes !== 0 || accounting.processOutput.retainedBytes !== stdout.bytes.length || stdout.bytes.length > outputCeiling
      || !same(accounting.workspace?.before, emptyRuntime) || !same(accounting.workspace?.after, emptyRuntime)
      || accounting.workspace.byteCeiling !== Math.min(receipt.resourceLimits.maxWritableBytes, config.maxWritableBytes ?? FORGE_LIMIT_DEFAULTS.maxWritableBytes)
      || accounting.workspace.inodeCeiling !== Math.min(receipt.resourceLimits.maxWritableInodes, 10_000, config.maxWritableInodes ?? config.maxFiles ?? FORGE_LIMIT_DEFAULTS.maxWritableInodes)
      || accounting.workspace.after.inodes > accounting.workspace.inodeCeiling) refuse("PURE_RAW_RESOURCE_ACCOUNTING_MISMATCH");
    outcome = prepared.expectedResult.analysis.outcome;
    return { authority: "none", authenticatedCase, consistent: true, outcome, problems: [] };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{3,80}$/u.test(error.message) ? error.message : "PURE_EXECUTION_REPLAY_REFUSED";
    return { authority: "none", authenticatedCase, consistent: false, outcome, problems: [code] };
  }
}
