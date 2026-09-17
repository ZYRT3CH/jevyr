import { parseJsonBytes, verifyEventChain } from "@jevyr/core";
import { canonicalize, digestJson, isSha256Digest, sha256Digest, type CaseEvent, type JsonValue } from "@jevyr/protocol";
import { decodeExactByteCapture, decodeToolObservation } from "./evidence-artifacts.js";
import { verifyForgeExecutionAuthority } from "./forge-authority.js";
import { FORGE_LIMIT_DEFAULTS } from "./forge.js";
import { MAX_ORACLE_WORKSPACE_ENTRIES } from "./typed-oracles.js";
import { deriveRepositoryEvaluationPackage, repositoryEvaluationObserverPolicyFromDescriptor, repositoryObserverArtifactMediaType, type RepositoryObserverReceipt } from "./repository-evaluation-observer.js";
import type { RepositoryEvaluationClosure } from "./repository-evaluation-closure.js";
import { createRepositoryTestControllerRequest, type RepositoryTestControllerRequest } from "./repository-test-controller.js";
import type { RepositorySubjectEvaluation } from "./repository-evaluation-plan.js";
import type { ToolObservation } from "./contracts.js";

export const REPOSITORY_OBSERVER_ACTION = "repository-evaluation.observe" as const;
export interface RepositoryObserverBaseline {
  readonly forgeWallMillis: number;
  readonly measuredForgeCpuMillis: number;
  readonly cpuMeasurements: number;
  readonly cpuUnmeasured: boolean;
  readonly workspaceUnmeasured: boolean;
  readonly writableBytes: number;
  readonly writableInodes: number;
  readonly artifactBytes: number;
  readonly totalAssayCost: 0;
}
export interface RepositoryObserverReplay {
  readonly baseline: RepositoryObserverBaseline;
  readonly observations: readonly { readonly sequence: number; readonly receiptDigest: string; readonly receipt: RepositoryObserverReceipt }[];
  readonly artifactDigests: readonly string[];
  readonly problems: readonly { readonly sequence: number; readonly message: string }[];
  readonly verdictAuthority: "none";
}
const zero = (): RepositoryObserverBaseline => ({ forgeWallMillis: 0, measuredForgeCpuMillis: 0, cpuMeasurements: 0,
  cpuUnmeasured: false, workspaceUnmeasured: false, writableBytes: 0, writableInodes: 0, artifactBytes: 0, totalAssayCost: 0 });
const json = (value: unknown) => value as JsonValue;
const hash = (value: unknown) => digestJson(json(value));
const same = (a: unknown, b: unknown) => canonicalize(json(a)) === canonicalize(json(b));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const refuse = (message: string): never => { throw new TypeError(message); };
function canonical(bytes: Uint8Array): Record<string, unknown> {
  const value = parseJsonBytes(bytes, "Repository observer artifact");
  if (!object(value) || canonicalize(json(value)) !== Buffer.from(bytes).toString("utf8")) return refuse("Diagnostic artifact is not a canonical JSON object.");
  return value;
}
function sum(a: number, b: number): number {
  const result = a + b;
  if (!natural(result)) return refuse("Diagnostic accounting exceeded safe integer precision.");
  return result;
}

/** Shape validation alone grants neither provenance nor an evidence edge. */
export function decodeRepositoryObserverReceipt(bytes: Uint8Array): RepositoryObserverReceipt {
  if (bytes.byteLength > 64_000) return refuse("Diagnostic receipt exceeds its retained byte ceiling.");
  const value = canonical(bytes);
  if (!exact(value, ["protocol", "caseId", "runDigest", "policyDigest", "invocationId", "subjectId", "planDigest", "closureDigest", "packageDigest", "controllerSourceDigest", "requestDigest", "outerObservationDigest", "controllerObservationDigest", "target", "scope", "workspaceRole", "authority", "reportOutcome", "controllerConsistent", "counts", "problems", "resourceLimits", "artifacts", "resources"])
    || value.protocol !== "jevyr.repository-evaluation-observer-receipt/1" || value.target !== "sealed-original-subject" || value.scope !== "selected-static-test-closure"
    || value.workspaceRole !== "empty-diagnostic-tooling" || value.authority !== "none" || !["pass", "fail", "unproven"].includes(String(value.reportOutcome)) || typeof value.controllerConsistent !== "boolean"
    || ["caseId", "invocationId", "subjectId"].some(key => typeof value[key] !== "string" || !/^[A-Za-z0-9._-]{1,256}$/u.test(value[key] as string))
    || ["runDigest", "policyDigest", "planDigest", "closureDigest", "packageDigest", "controllerSourceDigest", "requestDigest", "outerObservationDigest"].some(key => !isSha256Digest(value[key]))
    || value.controllerObservationDigest !== null && !isSha256Digest(value.controllerObservationDigest)
    || !Array.isArray(value.problems) || value.problems.length > 128 || value.problems.some(item => typeof item !== "string" || !/^[A-Z0-9_]{3,120}$/u.test(item))
    || !value.problems.includes("DIAGNOSTIC_ONLY_NO_VERDICT_AUTHORITY") || !same(value.problems, [...new Set(value.problems)].sort())) return refuse("Diagnostic receipt has an invalid or authority-bearing shape.");
  if (value.counts !== null && (!exact(value.counts, ["executedTests", "passed", "failed", "errors", "skipped", "cancelled"]) || Object.values(value.counts).some(item => !natural(item)))) return refuse("Diagnostic report counts are malformed.");
  if (!exact(value.resourceLimits, ["maxWritableBytes", "maxWritableInodes", "maxArtifactBytes", "timeoutMs"]) || Object.values(value.resourceLimits).some(item => !natural(item) || item < 1)) return refuse("Diagnostic narrowed limits are malformed.");
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 6 || value.artifacts.length > 7) return refuse("Diagnostic sidecar membership is incomplete or oversized.");
  let previous = "";
  for (const artifact of value.artifacts) {
    if (!exact(artifact, ["name", "digest", "byteLength", "mediaType"]) || typeof artifact.name !== "string" || artifact.name <= previous || !isSha256Digest(artifact.digest)
      || !natural(artifact.byteLength) || artifact.byteLength > 32_000_000 || artifact.mediaType !== repositoryObserverArtifactMediaType(artifact.name)) return refuse("Diagnostic sidecar inventory is not exact, bounded and ordered.");
    previous = artifact.name;
  }
  const required = ["closureBytes", "controllerSourceBytes", "outerForgeObservationBytes", "packageBytes", "planBytes", "requestBytes", ...(value.controllerObservationDigest === null ? [] : ["controllerObservationBytes"])].sort();
  if (!same(value.artifacts.map(item => item.name), required)) return refuse("Diagnostic sidecar names do not match its retained captures.");
  const resource = value.resources;
  if (!exact(resource, ["wallMillis", "elapsedMeasurement", "executionAttempted", "cpuMillis", "cpuMeasurement", "writableBytes", "writableInodes", "workspaceMeasurement", "artifactBytes"])
    || resource.elapsedMeasurement !== "HOST_MONOTONIC" || !natural(resource.wallMillis) || !natural(resource.writableBytes) || !natural(resource.writableInodes) || !natural(resource.artifactBytes)
    || typeof resource.executionAttempted !== "boolean" || !["MEASURED", "UNMEASURED", "NOT_ATTEMPTED"].includes(String(resource.cpuMeasurement))
    || !["MEASURED", "CONSERVATIVE_CEILING", "NOT_ATTEMPTED"].includes(String(resource.workspaceMeasurement))
    || resource.cpuMillis !== null && !natural(resource.cpuMillis)) return refuse("Diagnostic measurements are malformed.");
  return value as unknown as RepositoryObserverReceipt;
}

/** Independently reconstruct raw physical readings; reports and model claims are irrelevant. */
function physical(observation: ToolObservation, receipt: RepositoryObserverReceipt, config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const limits = receipt.resourceLimits;
  const configuredLimit = (key: string, fallback: number): number => {
    const value = config[key] ?? fallback;
    if (!natural(value)) return refuse("Diagnostic sealed adapter limits are malformed.");
    return value;
  };
  const byteCeiling = Math.min(limits.maxWritableBytes, configuredLimit("maxWritableBytes", FORGE_LIMIT_DEFAULTS.maxWritableBytes));
  const inodeCeiling = Math.min(limits.maxWritableInodes, MAX_ORACLE_WORKSPACE_ENTRIES, configuredLimit("maxWritableInodes", configuredLimit("maxFiles", FORGE_LIMIT_DEFAULTS.maxWritableInodes)));
  const outputCeiling = configuredLimit("maxProcessOutputBytes", FORGE_LIMIT_DEFAULTS.maxProcessOutputBytes);
  const accounting = observation.metadata?.resourceAccounting;
  const recorded = object(accounting) && accounting.protocol === "jevyr.forge-resource-accounting/1" ? accounting : undefined;
  const output = object(recorded?.processOutput) ? recorded.processOutput : undefined;
  const execution = observation.oracle?.execution;
  const attempted = output?.measurement === "MEASURED" || execution?.state === "exited" || execution?.state === "timed-out";
  const wall = object(recorded?.wall) ? recorded.wall : undefined;
  if (attempted && (wall?.measurement !== "MEASURED" || typeof wall.usedMillis !== "number" || !Number.isFinite(wall.usedMillis) || wall.usedMillis < 0
    || receipt.resources.wallMillis < wall.usedMillis)) return refuse("Diagnostic host elapsed reading understates or lacks the raw monotonic process duration.");
  if (output?.measurement === "MEASURED") {
    const stdout = observation.stdoutCapture ?? execution?.stdoutCapture, stderr = observation.stderrCapture ?? execution?.stderrCapture;
    if (!stdout || !stderr || output.complete !== true || !natural(output.usedBytes) || !natural(output.stdoutBytes) || !natural(output.stderrBytes)
      || !natural(output.retainedBytes) || output.ceilingBytes !== outputCeiling || output.retainedBytes > outputCeiling || output.usedBytes !== output.stdoutBytes + output.stderrBytes
      || output.stdoutBytes !== stdout.observedByteLength || output.stderrBytes !== stderr.observedByteLength || output.retainedBytes !== stdout.byteLength + stderr.byteLength
      || output.exactCapturesComplete !== (stdout.complete && stderr.complete)) return refuse("Diagnostic raw process output accounting is incomplete or inconsistent.");
    decodeExactByteCapture(stdout); decodeExactByteCapture(stderr);
  } else if (attempted) return refuse("Diagnostic attempted process lacks measured output accounting.");
  const cpu = object(recorded?.cpu) ? recorded.cpu : undefined;
  if (cpu?.measurement === "MEASURED" && !natural(cpu.usedMillis)) return refuse("Diagnostic CPU claims a measured invalid reading.");
  if (cpu?.measurement !== "MEASURED" && cpu?.usedMillis !== null && cpu?.usedMillis !== undefined) return refuse("Diagnostic unmeasured CPU claims a numeric reading.");
  const cpuMeasured = attempted && cpu?.measurement === "MEASURED";
  const workspace = object(recorded?.workspace) ? recorded.workspace : undefined;
  const after = object(workspace?.after) ? workspace.after : undefined;
  if (workspace && (workspace.byteCeiling !== byteCeiling || workspace.inodeCeiling !== inodeCeiling)) return refuse("Diagnostic physical ceilings disagree with the exact narrowed invocation and sealed adapter limits.");
  const workspaceMeasured = after?.measurement === "MEASURED" && after.complete === true;
  if (workspaceMeasured && (!natural(after.bytes) || !natural(after.inodes))) return refuse("Diagnostic workspace claims a complete invalid reading.");
  if (after && !workspaceMeasured && (after.bytes !== null || after.inodes !== null)) return refuse("Diagnostic partial workspace masquerades as measured.");
  return { wallMillis: receipt.resources.wallMillis, elapsedMeasurement: "HOST_MONOTONIC", executionAttempted: attempted,
    cpuMillis: cpuMeasured ? cpu!.usedMillis : null, cpuMeasurement: cpuMeasured ? "MEASURED" : attempted ? "UNMEASURED" : "NOT_ATTEMPTED",
    writableBytes: workspaceMeasured ? after!.bytes : attempted ? limits.maxWritableBytes : 0,
    writableInodes: workspaceMeasured ? after!.inodes : attempted ? limits.maxWritableInodes : 0,
    workspaceMeasurement: workspaceMeasured ? "MEASURED" : attempted ? "CONSERVATIVE_CEILING" : "NOT_ATTEMPTED" };
}

/** Authenticated transcript callers still verify the Record signature separately.
 * This check admits resource costs only and never returns a verdict evidence edge. */
export async function replayRepositoryObservers(events: readonly CaseEvent[], policyDescriptor: unknown, resolve: (digest: string) => Promise<Uint8Array | undefined>, initial: {
  readonly initialBaseline?: RepositoryObserverBaseline;
  readonly initialArtifacts?: readonly { readonly digest: string; readonly byteLength: number }[];
} = {}): Promise<RepositoryObserverReplay> {
  let baseline = { ...(initial.initialBaseline ?? zero()) };
  const problems: { sequence: number; message: string }[] = [], observations: RepositoryObserverReplay["observations"][number][] = [];
  const charged = new Map<string, number>();
  for (const entry of initial.initialArtifacts ?? []) {
    if (!isSha256Digest(entry.digest) || !natural(entry.byteLength) || charged.has(entry.digest)) throw new TypeError("Initial diagnostic accounting is not a distinct bounded artifact inventory.");
    charged.set(entry.digest, entry.byteLength);
  }
  if ([baseline.forgeWallMillis, baseline.measuredForgeCpuMillis, baseline.cpuMeasurements, baseline.writableBytes, baseline.writableInodes, baseline.artifactBytes].some(value => !natural(value))
    || typeof baseline.cpuUnmeasured !== "boolean" || typeof baseline.workspaceUnmeasured !== "boolean" || baseline.totalAssayCost !== 0
    || [...charged.values()].reduce(sum, 0) !== baseline.artifactBytes) throw new TypeError("Initial diagnostic accounting does not match its verified artifact inventory.");
  const actions = events.filter((event): event is CaseEvent<"action.status"> => event.kind === "action.status" && event.payload.actionType === REPOSITORY_OBSERVER_ACTION);
  if (!actions.length) return Object.freeze({ baseline: Object.freeze(baseline), observations: [], artifactDigests: Object.freeze([...charged.keys()].sort()), problems: [], verdictAuthority: "none" });
  try {
    if (!verifyEventChain(events).valid) return refuse("Diagnostic replay requires an intact event chain.");
    const policy = repositoryEvaluationObserverPolicyFromDescriptor(policyDescriptor);
    if (!policy || !object(policyDescriptor) || !object(policyDescriptor.policy) || !object(policyDescriptor.policy.assayFrontier) || !object(policyDescriptor.policy.assayFrontier.aggregateLimits)) return refuse("Diagnostic work has no exact supported presealed factory and aggregate envelope.");
    const limits = policyDescriptor.policy.assayFrontier.aggregateLimits;
    for (const key of ["maxForgeWallMillis", "maxForgeCpuMillis", "maxWritableBytes", "maxWritableInodes", "maxArtifactBytes"]) if (!natural(limits[key])) return refuse("Diagnostic aggregate envelope is invalid.");
    const policyDigest = hash(policyDescriptor), caseDigest = events[0]!.caseDigest, runDigest = events[0]!.runDigest;
    const forgeConfig = policyDescriptor.policy.effectiveForgeConfig;
    if (!object(forgeConfig) || forgeConfig.allowNetwork === true) return refuse("Diagnostic lacks its presealed network-denied built-in adapter configuration.");
    const firstMindOrAssay = events.find(event => event.kind === "action.status" && event.payload.actionType === "mind.contribute"
      || ["interpret", "diverge", "recombine", "embody", "challenge", "assay", "reflex", "crystallize", "sign", "memory_tribunal", "terminate"].includes(event.stage))?.sequence ?? Number.MAX_SAFE_INTEGER;
    const starts = new Map<string, CaseEvent<"action.status">>(), finished = new Set<string>(), subjects = new Set<string>(), denied = new Set<string>();
    let lastTerminal = 0, commonCaseId: string | undefined;
    for (const action of actions) {
      try {
        if (action.actor.kind !== "kernel" || action.actor.id !== "jevyr.bone" || action.stage !== "self_scan" || action.sequence >= firstMindOrAssay || action.caseDigest !== caseDigest || action.runDigest !== runDigest) return refuse("Diagnostic action is not a same-Case pre-investigation Bone action.");
        if (action.payload.status === "denied" && !starts.has(action.payload.actionId) && !denied.has(action.payload.actionId)
          && !action.payload.artifactDigests?.length && action.payload.resource === undefined) { denied.add(action.payload.actionId); continue; }
        if (action.payload.status === "started") {
          if (denied.has(action.payload.actionId) || starts.has(action.payload.actionId) || starts.size > finished.size || starts.size >= policy.maxSubjectsPerCase || action.sequence <= lastTerminal || action.payload.artifactDigests?.length) return refuse("Diagnostic starts are duplicated, concurrent, reordered or over their sealed subject cap.");
          starts.set(action.payload.actionId, action); continue;
        }
        const start = starts.get(action.payload.actionId);
        if (!["completed", "failed"].includes(action.payload.status) || !start || start.sequence >= action.sequence || finished.has(action.payload.actionId)) return refuse("Diagnostic terminal action has no unique preceding start.");
        const digests = action.payload.artifactDigests;
        if (!digests || digests.length < 7 || digests.length > 8 || new Set(digests).size !== digests.length || digests.some(digest => !isSha256Digest(digest))) return refuse("Diagnostic terminal action lacks exact artifact membership.");
        const bundle = new Map<string, Uint8Array>();
        for (const digest of digests) {
          const raw = await resolve(digest);
          if (!(raw instanceof Uint8Array) || raw.byteLength > 32_000_000 || sha256Digest(raw) !== digest) return refuse("Diagnostic sidecar is absent, changed or oversized.");
          bundle.set(digest, raw);
        }
        const receipts = [...bundle].filter(([, raw]) => { try { return canonical(raw).protocol === "jevyr.repository-evaluation-observer-receipt/1"; } catch { return false; } });
        if (receipts.length !== 1) return refuse("Diagnostic action does not bind exactly one receipt.");
        const [receiptDigest, receiptBytes] = receipts[0]!, receipt = decodeRepositoryObserverReceipt(receiptBytes);
        if (receipt.runDigest !== runDigest || receipt.policyDigest !== policyDigest || receipt.invocationId !== action.payload.actionId || commonCaseId !== undefined && receipt.caseId !== commonCaseId || subjects.has(receipt.subjectId)) return refuse("Diagnostic receipt scope is substituted or its subject is repeated.");
        const inventory = new Map(receipt.artifacts.map(artifact => [artifact.name, artifact]));
        if (!same([...new Set([...receipt.artifacts.map(artifact => artifact.digest), receiptDigest])].sort(), [...digests].sort())) return refuse("Diagnostic action artifact membership differs from its receipt.");
        for (const artifact of receipt.artifacts) if (bundle.get(artifact.digest)?.byteLength !== artifact.byteLength) return refuse("Diagnostic retained sidecar byte length differs from its receipt.");
        const raw = (name: string): Uint8Array => bundle.get(inventory.get(name)?.digest ?? "") ?? refuse("Diagnostic required sidecar is missing.");
        const plan = canonical(raw("planBytes")), closure = canonical(raw("closureBytes")), packaged = canonical(raw("packageBytes")), request = canonical(raw("requestBytes"));
        if (plan.protocol !== "jevyr.repository-evaluation-plan/1" || plan.digest !== receipt.planDigest || hash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "digest"))) !== plan.digest
          || closure.protocol !== "jevyr.repository-evaluation-closure/1" || closure.materializationDigest !== receipt.closureDigest || hash(Object.fromEntries(Object.entries(closure).filter(([key]) => key !== "materializationDigest"))) !== closure.materializationDigest
          || closure.subjectId !== receipt.subjectId || closure.captureDigest !== plan.captureDigest || !Array.isArray(plan.subjects)) return refuse("Diagnostic plan and selected closure identities disagree.");
        const eligible = plan.subjects.filter(subject => object(subject) && subject.status === "ready" && Array.isArray(subject.refusals) && subject.refusals.length === 0).sort((a, b) => String(a.subjectId) < String(b.subjectId) ? -1 : 1).slice(0, policy.maxSubjectsPerCase);
        const selected = eligible.find(subject => subject.subjectId === receipt.subjectId && subject.suiteDigest === closure.suiteDigest);
        if (!selected || !same(selected.runner, policy.runner) || !same(plan.limits, policy.limits)
          || !same(request, createRepositoryTestControllerRequest(selected as unknown as RepositorySubjectEvaluation, "/subject/repository-evaluation/closure", policy.controllerLimits))) return refuse("Diagnostic subject or controller request is outside the bounded presealed plan selection.");
        if (receipt.controllerSourceDigest !== policy.controllerSourceDigest || sha256Digest(raw("controllerSourceBytes")) !== receipt.controllerSourceDigest || hash(request) !== receipt.requestDigest
          || packaged.digest !== receipt.packageDigest || !same(packaged, deriveRepositoryEvaluationPackage(closure as unknown as RepositoryEvaluationClosure, request as unknown as RepositoryTestControllerRequest, raw("controllerSourceBytes")))) return refuse("Diagnostic fixed controller, request or exact mount package is substituted.");
        if (sha256Digest(raw("outerForgeObservationBytes")) !== receipt.outerObservationDigest || receipt.controllerObservationDigest !== (inventory.get("controllerObservationBytes")?.digest ?? null)) return refuse("Diagnostic observation digest binding is invalid.");
        const observation = decodeToolObservation(raw("outerForgeObservationBytes"));
        if (observation.invocationId !== receipt.invocationId || (observation.status === "succeeded" ? "completed" : "failed") !== action.payload.status || (observation.artifactRefs?.length ?? 0) !== 0) return refuse("Diagnostic invocation status or undeclared output artifacts disagree.");
        const expectedLimits = { maxWritableBytes: Number(limits.maxWritableBytes) - baseline.writableBytes, maxWritableInodes: Number(limits.maxWritableInodes) - baseline.writableInodes,
          maxArtifactBytes: Number(limits.maxArtifactBytes) - baseline.artifactBytes, timeoutMs: Math.min(policy.timeoutMs, Number(limits.maxForgeWallMillis) - baseline.forgeWallMillis) };
        if (Object.values(expectedLimits).some(item => !natural(item) || item < 1) || expectedLimits.timeoutMs < 100 || Number(limits.maxForgeCpuMillis) === 0
          || baseline.cpuMeasurements > 0 && baseline.measuredForgeCpuMillis >= Number(limits.maxForgeCpuMillis) || !same(receipt.resourceLimits, expectedLimits)) return refuse("Diagnostic invocation did not use the exact remaining original physical envelope.");
        const readings = physical(observation, receipt, forgeConfig), { artifactBytes: _bytes, ...claimedReadings } = receipt.resources;
        if (!same(readings, claimedReadings)) return refuse("Diagnostic claimed resources or measurement flags differ from raw Forge readings.");
        if (observation.oracle) {
          const execution = observation.oracle.execution, boundary = observation.oracle.subjectBoundary, network = observation.oracle.networkIsolation;
          if (!verifyForgeExecutionAuthority(policyDescriptor, observation.oracle).verified || execution.command !== "node" || execution.shell !== false || !same(execution.args, policy.argv)
            || !boundary || boundary.captureDigest !== receipt.packageDigest || boundary.materializationDigest !== receipt.packageDigest || boundary.beforeDigest !== packaged.forgeTreeDigest || boundary.afterDigest !== packaged.forgeTreeDigest
            || boundary.complete !== true || boundary.sanitized !== true || boundary.disposableWorkspace !== true || boundary.sealedSubjectReadOnly !== true || boundary.originalSubjectAccessible !== false
            || !network || network.schema !== "jevyr.docker-network-none/1" || network.networkMode !== "none" || network.enforced !== true || network.complete !== true || network.externalAccessCount !== 0) return refuse("Diagnostic execution provenance or immutable mount binding is invalid.");
          const mustRetainController = execution.state === "exited" && execution.exitCode === 0 && execution.outputTruncated === false;
          if (mustRetainController !== (receipt.controllerObservationDigest !== null)) return refuse("Diagnostic raw process result and controller-output retention disagree.");
          if (receipt.controllerObservationDigest !== null && (!execution.stdoutCapture || !Buffer.from(decodeExactByteCapture(execution.stdoutCapture).bytes).equals(Buffer.from(raw("controllerObservationBytes"))))) return refuse("Diagnostic controller sidecar is not the exact captured process output.");
        } else if (observation.status === "succeeded" || receipt.controllerObservationDigest !== null || receipt.controllerConsistent || receipt.reportOutcome !== "unproven") return refuse("Diagnostic missing execution provenance claims a successful report.");
        const artifactBytes = [...bundle.values()].reduce((total, value) => sum(total, value.byteLength), 0);
        if (receipt.resources.artifactBytes !== artifactBytes || artifactBytes > receipt.resourceLimits.maxArtifactBytes) return refuse("Diagnostic artifact accounting is not the exact retained distinct byte sum.");
        if (!action.payload.resource || (action.payload.resource.wallMillis !== receipt.resources.wallMillis || action.payload.resource.bytesWritten !== receipt.resources.writableBytes
          || action.payload.resource.cpuMillis !== undefined && action.payload.resource.cpuMillis !== receipt.resources.cpuMillis)) return refuse("Diagnostic action telemetry disagrees with its raw receipt.");
        const referenced = new Set(bundle.keys());
        if (events.some(event => event.kind === "evidence.observed" && referenced.has(event.payload.contentDigest)
          || event.kind === "candidate.status" && event.payload.artifactDigests?.some(digest => referenced.has(digest)))) return refuse("Diagnostic-only artifacts acquired candidate or evidence authority edges.");
        let additionalBytes = 0;
        for (const [digest, value] of bundle) if (!charged.has(digest)) { charged.set(digest, value.byteLength); additionalBytes = sum(additionalBytes, value.byteLength); }
        baseline = { forgeWallMillis: sum(baseline.forgeWallMillis, receipt.resources.wallMillis),
          measuredForgeCpuMillis: sum(baseline.measuredForgeCpuMillis, receipt.resources.cpuMillis ?? 0), cpuMeasurements: sum(baseline.cpuMeasurements, receipt.resources.cpuMeasurement === "MEASURED" ? 1 : 0),
          cpuUnmeasured: baseline.cpuUnmeasured || receipt.resources.cpuMeasurement === "UNMEASURED", workspaceUnmeasured: baseline.workspaceUnmeasured || receipt.resources.workspaceMeasurement === "CONSERVATIVE_CEILING",
          writableBytes: sum(baseline.writableBytes, receipt.resources.writableBytes), writableInodes: sum(baseline.writableInodes, receipt.resources.writableInodes), artifactBytes: sum(baseline.artifactBytes, additionalBytes), totalAssayCost: 0 };
        observations.push({ sequence: action.sequence, receiptDigest, receipt }); finished.add(action.payload.actionId); subjects.add(receipt.subjectId); commonCaseId = receipt.caseId; lastTerminal = action.sequence;
      } catch (error) { problems.push({ sequence: action.sequence, message: error instanceof Error ? error.message : "Diagnostic replay refused malformed input." }); }
    }
    for (const [id, start] of starts) if (!finished.has(id)) problems.push({ sequence: start.sequence, message: "Diagnostic start has no independently verified terminal resource receipt." });
  } catch (error) { problems.push({ sequence: actions[0]!.sequence, message: error instanceof Error ? error.message : "Diagnostic replay refused malformed input." }); }
  return Object.freeze({ baseline: Object.freeze(baseline), observations: Object.freeze(observations), artifactDigests: Object.freeze([...charged.keys()].sort()), problems: Object.freeze(problems), verdictAuthority: "none" });
}
