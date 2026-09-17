import { readFileSync } from "node:fs";
import { decodeDsseJson, obligationsFromIntentContract, originalSubjectPurpose, originalSubjectKernelDigestFromPolicyDescriptor, ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST, ORIGINAL_SUBJECT_POLICY_VERSION, parseJsonBytes, sealReceipt, SEAL_DSSE_PAYLOAD_TYPE, verifyDsse, verifyEventChain, type OriginalSubjectContext, type VerifiedEvidenceEdge } from "@jevyr/core";
import { canonicalize, digestJson, isSha256Digest, sha256Digest, type CaseEvent, type DsseEnvelope, type JsonValue, type SealedCase } from "@jevyr/protocol";
import { deriveRepositoryPureAssertionContext } from "./repository-pure-assertions.js";
import { assertRepositoryPureProducerAssets, repositoryPureProducerAssetsForCurrentBuild, type RepositoryPureProducerAssets } from "./repository-pure-producer.js";
import { decodeRepositoryPureProducerRequest, pureProducerPath } from "./repository-pure-producer-data.js";
import { replayRepositoryPureExecution, type RepositoryPureExecutionReceipt, type RepositoryPureResources, type executeRepositoryPureAssertions } from "./repository-pure-execution.js";
import type { RepositoryObserverBaseline } from "./repository-observer-replay.js";
import type { SubjectMaterialManifest } from "./subject-materials.js";

export const ORIGINAL_SUBJECT_CERTIFICATE_PROTOCOL = "jevyr.original-subject-assertion-certificate/1" as const;
export const ORIGINAL_SUBJECT_CERTIFICATE_MEDIA = "application/vnd.jevyr.original-subject-assertion-certificate+json" as const;
export const ORIGINAL_SUBJECT_CERTIFICATE_ACTION = "repository-pure.evaluate" as const;
export const MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES = 8 * 1024 * 1024;
export const ORIGINAL_SUBJECT_CERTIFICATE_CHECKER = Object.freeze({protocol:"jevyr.original-subject-certificate-checker/1",implementationDigest:sha256Digest(readFileSync(new URL(import.meta.url)))});
export interface OriginalSubjectCertificate {
  readonly protocol: typeof ORIGINAL_SUBJECT_CERTIFICATE_PROTOCOL;
  readonly caseId: string; readonly caseDigest: string; readonly runDigest: string; readonly policyDigest: string;
  readonly captureDigest: string; readonly subjectId: string; readonly obligationId: string; readonly kernelDigest: string;
  readonly executionReceiptDigest: string;
  readonly artifacts: readonly Readonly<{ name: string; digest: string; byteLength: number; base64: string }>[];
}
export interface OriginalSubjectCertificateContext {
  /** Trust comes from the verifier host; never derive these keys from this certificate. */
  readonly sealedCase: SealedCase;
  readonly sealEnvelope: DsseEnvelope;
  readonly trustedCaseKeys: ReadonlyMap<string, string>;
  /** Optional private assets. The default builds once in source mode and loads
   * pinned prebuilt assets in compiled installations, without runtime rebuilding. */
  readonly assets?: RepositoryPureProducerAssets;
}
export interface OriginalSubjectCertificateReplay {
  readonly baseline: RepositoryObserverBaseline;
  readonly artifactDigests: readonly string[];
  readonly verifiedOriginalSubjectEdges: readonly VerifiedEvidenceEdge[];
  readonly originalSubjectContext?: OriginalSubjectContext;
  readonly observations: readonly Readonly<{ sequence: number; certificateDigest: string; executionReceiptDigest: string; outcome: "match" | "mismatch" | "unavailable"; resources: RepositoryPureResources }>[];
  readonly problems: readonly Readonly<{ sequence: number; message: string }>[];
}
const hash = (value: unknown) => digestJson(value as JsonValue);
const encoded = (value: unknown) => Buffer.from(canonicalize(value as JsonValue));
const same = (left: unknown, right: unknown) => canonicalize(left as JsonValue) === canonicalize(right as JsonValue);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).sort().join() === [...fields].sort().join();
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/u.test(value);
function fail(code: string): never { throw new TypeError(code); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const zero = (): RepositoryObserverBaseline => ({ forgeWallMillis: 0, measuredForgeCpuMillis: 0, cpuMeasurements: 0, cpuUnmeasured: false, workspaceUnmeasured: false, writableBytes: 0, writableInodes: 0, artifactBytes: 0, totalAssayCost: 0 });
let builtAssets: Promise<RepositoryPureProducerAssets> | undefined;
export function originalSubjectProducerAssets(): Promise<RepositoryPureProducerAssets> { return builtAssets ??= repositoryPureProducerAssetsForCurrentBuild(); }

/** Exact first physical reservation, shared by live scheduling and replay. */
export function originalSubjectExecutionLimits(sealed: SealedCase, policyDescriptor: unknown): Readonly<{resourceLimits:Readonly<{maxWritableBytes:number;maxWritableInodes:number;maxArtifactBytes:number}>;timeoutMs:number}> {
  if (hash(policyDescriptor) !== sealed.policyDigest) fail("ORIGINAL_POLICY_BINDING");
  const policy = object(policyDescriptor) && object(policyDescriptor.policy) ? policyDescriptor.policy : fail("ORIGINAL_POLICY_SHAPE");
  const frontier = object(policy.assayFrontier) ? policy.assayFrontier : fail("ORIGINAL_FRONTIER_MISSING"), aggregate = object(frontier.aggregateLimits) ? frontier.aggregateLimits : fail("ORIGINAL_ENVELOPE_MISSING");
  const factory = object(policy.repositoryPureAssertions) ? policy.repositoryPureAssertions : fail("ORIGINAL_FACTORY_MISSING"), envelope = sealed.searchEnvelope.profile.resources;
  for(const key of ["maxWritableBytes","maxWritableInodes","maxArtifactBytes","maxForgeWallMillis","maxForgeCpuMillis"] as const) if(!natural(aggregate[key]) || Number(aggregate[key]) < 1 || Number(aggregate[key]) > envelope[key]) fail("ORIGINAL_ENVELOPE_LIMIT");
  if(!natural(factory.timeoutMs) || factory.timeoutMs < 100 || factory.timeoutMs > 30_000) fail("ORIGINAL_FACTORY_DEADLINE");
  const timeoutMs=Math.min(factory.timeoutMs,envelope.maxSingleInvocationMillis,envelope.maxWallMillis,Number(aggregate.maxForgeWallMillis));
  if(timeoutMs<100)fail("ORIGINAL_DEADLINE_EXHAUSTED");
  return freeze({resourceLimits:{maxWritableBytes:Number(aggregate.maxWritableBytes),maxWritableInodes:Number(aggregate.maxWritableInodes),maxArtifactBytes:Number(aggregate.maxArtifactBytes)},timeoutMs});
}

/** Closed bounded data decoding. This alone provides no authentication or edge. */
export function decodeOriginalSubjectCertificate(bytes: Uint8Array): OriginalSubjectCertificate {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES) fail("ORIGINAL_CERTIFICATE_BYTE_LIMIT");
  const value = parseJsonBytes(bytes);
  if (!exact(value, ["protocol", "caseId", "caseDigest", "runDigest", "policyDigest", "captureDigest", "subjectId", "obligationId", "kernelDigest", "executionReceiptDigest", "artifacts"])
    || value.protocol !== ORIGINAL_SUBJECT_CERTIFICATE_PROTOCOL || !identifier(value.caseId) || !identifier(value.subjectId) || !identifier(value.obligationId)
    || [value.caseDigest, value.runDigest, value.policyDigest, value.captureDigest, value.kernelDigest, value.executionReceiptDigest].some(item => !isSha256Digest(item))
    || !Array.isArray(value.artifacts) || value.artifacts.length < 8 || value.artifacts.length > 512) fail("ORIGINAL_CERTIFICATE_SHAPE");
  let previous = "", total = 0;
  for (const item of value.artifacts) {
    if (!exact(item, ["name", "digest", "byteLength", "base64"]) || typeof item.name !== "string" || !pureProducerPath(item.name) || item.name <= previous
      || !isSha256Digest(item.digest) || !natural(item.byteLength) || item.byteLength > MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES
      || typeof item.base64 !== "string" || item.base64.length !== Math.ceil(item.byteLength / 3) * 4) fail("ORIGINAL_CERTIFICATE_SIDECAR_SHAPE");
    const raw = Buffer.from(item.base64, "base64"); total += raw.length;
    if (raw.length !== item.byteLength || raw.toString("base64") !== item.base64 || sha256Digest(raw) !== item.digest || total > MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES) fail("ORIGINAL_CERTIFICATE_SIDECAR_BINDING");
    previous = item.name;
  }
  if (value.artifacts.find(item => item.name === "receipt.json")?.digest !== value.executionReceiptDigest || !Buffer.from(bytes).equals(encoded(value))) fail("ORIGINAL_CERTIFICATE_ENCODING");
  return freeze(value as unknown as OriginalSubjectCertificate);
}

/** Packages exact fixed-producer outputs. No caller-supplied outcome is retained. */
export function createOriginalSubjectCertificate(input: {
  readonly sealedCase: SealedCase; readonly kernelDigest: string;
  readonly execution: Awaited<ReturnType<typeof executeRepositoryPureAssertions>>;
}): Readonly<{ certificate: OriginalSubjectCertificate; bytes: Uint8Array; digest: string; executionReceiptDigest: string; resources: RepositoryPureResources }> {
  const context = deriveRepositoryPureAssertionContext(input.sealedCase), receiptBytes = input.execution.artifacts["receipt.json"];
  if (input.sealedCase.policyVersion !== ORIGINAL_SUBJECT_POLICY_VERSION || input.kernelDigest !== ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST || !(receiptBytes instanceof Uint8Array)) fail("ORIGINAL_CERTIFICATE_CONTEXT");
  const receipt = parseJsonBytes(receiptBytes) as unknown as RepositoryPureExecutionReceipt;
  if (!same(input.execution.receipt, receipt) || receipt.caseId !== context.caseId || receipt.caseDigest !== context.caseDigest || receipt.runDigest !== context.runDigest || receipt.policyDigest !== context.policyDigest) fail("ORIGINAL_CERTIFICATE_EXECUTION_CONTEXT");
  const certificate = { protocol: ORIGINAL_SUBJECT_CERTIFICATE_PROTOCOL, caseId: context.caseId, caseDigest: context.caseDigest, runDigest: context.runDigest, policyDigest: context.policyDigest,
    captureDigest: context.captureDigest, subjectId: context.subject.subjectId, obligationId: context.intentContract.criticalObligations[0]!.id, kernelDigest: input.kernelDigest,
    executionReceiptDigest: sha256Digest(receiptBytes), artifacts: Object.entries(input.execution.artifacts).map(([name, raw]) => ({ name, digest: sha256Digest(raw), byteLength: raw.byteLength, base64: Buffer.from(raw).toString("base64") })).sort((a,b)=>a.name<b.name?-1:1) };
  const bytes = encoded(certificate), checked = decodeOriginalSubjectCertificate(bytes), retained = Buffer.from(bytes);
  return Object.freeze({ certificate: checked, get bytes() { return Buffer.from(retained); }, digest: sha256Digest(bytes), executionReceiptDigest: checked.executionReceiptDigest, resources: freeze(structuredClone(receipt.resources)) });
}

/** Recover only explicit digest-addressed CAS sidecars. Paths in the authenticated
 * original declaration are neither inspected nor resolved by this reader. */
function restrictedSource(certificate: OriginalSubjectCertificate, assets: RepositoryPureProducerAssets) {
  assertRepositoryPureProducerAssets(assets);
  const artifacts = Object.fromEntries(certificate.artifacts.map(file => [file.name, Buffer.from(file.base64, "base64")]));
  const requestBytes = artifacts["mount/repository-pure/request.json"] ?? fail("ORIGINAL_REQUEST_MISSING");
  const request = decodeRepositoryPureProducerRequest(requestBytes, assets.descriptor);
  const manifests = new Map(request.manifests.map(file => [file.digest, file])), blobs = new Map(request.blobs.map(file => [file.digest, file]));
  const exactRead = (file: { path: string; digest: string; byteLength: number } | undefined): Buffer => {
    if (!file) fail("ORIGINAL_SOURCE_UNDECLARED"); const raw = artifacts[`mount/repository-pure/${file.path}`];
    if (!raw || raw.byteLength !== file.byteLength || sha256Digest(raw) !== file.digest) fail("ORIGINAL_SOURCE_BINDING"); return Buffer.from(raw);
  };
  return { artifacts, bindings: request.bindings, reader: {
    readManifest: async (binding: typeof request.bindings[number]) => {
      if (!same(binding, request.bindings[0])) fail("ORIGINAL_MANIFEST_SCOPE"); return parseJsonBytes(exactRead(manifests.get(binding.manifestDigest))) as unknown as SubjectMaterialManifest;
    },
    readBlob: async (digest: string, bytes: number) => { const file = blobs.get(digest); if (!file || file.byteLength !== bytes) fail("ORIGINAL_BLOB_SCOPE"); return exactRead(file); },
  } };
}

/** The caller authenticates the event prefix through its Record or just-in-time
 * signer. We independently authenticate the supplied Seal before source replay.
 * Only exact successful full reconstruction can emit the separate core edge. */
export async function replayOriginalSubjectCertificates(events: readonly CaseEvent[], policyDescriptor: unknown,
  resolve: (digest: string) => Promise<Uint8Array | undefined>, context?: OriginalSubjectCertificateContext): Promise<OriginalSubjectCertificateReplay> {
  let baseline = zero(); const artifacts: string[] = [], edges: VerifiedEvidenceEdge[] = [], observations: OriginalSubjectCertificateReplay["observations"][number][] = [];
  const problems: { sequence: number; message: string }[] = [];
  const actions = events.filter((event): event is CaseEvent<"action.status"> => event.kind === "action.status" && event.payload.actionType === ORIGINAL_SUBJECT_CERTIFICATE_ACTION);
  const evidence = events.filter((event): event is CaseEvent<"evidence.observed"> => event.kind === "evidence.observed" && event.payload.evidenceType === "original_subject_assertions");
  if (!actions.length && !evidence.length && (!object(policyDescriptor)||policyDescriptor.version!==ORIGINAL_SUBJECT_POLICY_VERSION) && context?.sealedCase.policyVersion!==ORIGINAL_SUBJECT_POLICY_VERSION) return freeze({ baseline, artifactDigests: artifacts, verifiedOriginalSubjectEdges: edges, observations, problems });
  let originalSubjectContext: OriginalSubjectContext | undefined;
  try {
    if (!verifyEventChain(events).valid || !context) fail("ORIGINAL_AUTHENTICATED_CONTEXT_MISSING");
    const kernelDigest = originalSubjectKernelDigestFromPolicyDescriptor(policyDescriptor);
    if (!kernelDigest || kernelDigest !== ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST || context.sealedCase.policyVersion !== ORIGINAL_SUBJECT_POLICY_VERSION || hash(policyDescriptor) !== context.sealedCase.policyDigest) fail("ORIGINAL_KERNEL_POLICY_MISMATCH");
    const boundPolicy=object(policyDescriptor)&&object(policyDescriptor.policy)?policyDescriptor.policy:fail("ORIGINAL_POLICY_SHAPE");
    if(!same(boundPolicy.originalSubjectCertificateChecker,ORIGINAL_SUBJECT_CERTIFICATE_CHECKER)||sha256Digest(readFileSync(new URL(import.meta.url)))!==ORIGINAL_SUBJECT_CERTIFICATE_CHECKER.implementationDigest)fail("ORIGINAL_CERTIFICATE_CHECKER_MISMATCH");
    const sealed = context.sealedCase;
    if(!context.trustedCaseKeys.size || context.sealEnvelope.payloadType!==SEAL_DSSE_PAYLOAD_TYPE || context.sealEnvelope.payload.length>4_000_000 || context.sealEnvelope.signatures.length>16
      || !verifyDsse(context.sealEnvelope,context.trustedCaseKeys) || !same(decodeDsseJson(context.sealEnvelope),sealReceipt(sealed))
      || !Buffer.from(context.sealEnvelope.payload,"base64").equals(encoded(sealReceipt(sealed))))fail("ORIGINAL_SEAL_AUTHENTICATION_FAILED");
    if (events.some(event => event.caseDigest !== sealed.caseDigest || event.runDigest !== sealed.runDigest)) fail("ORIGINAL_EVENT_CONTEXT_MISMATCH");
    const firstLater = events.find(event => event.kind === "candidate.status" || event.kind === "assay.status"
      || event.kind === "action.status" && ["mind.contribute", "repository-evaluation.observe"].includes(event.payload.actionType)
      || ["interpret","diverge","recombine","embody","challenge","assay","reflex","crystallize","sign","memory_tribunal","terminate"].includes(event.stage))?.sequence ?? Number.MAX_SAFE_INTEGER;
    const purposeContext={sealedCase:sealed,kernelDigest},purpose=originalSubjectPurpose({policyVersion:sealed.policyVersion,originalSubjectContext:purposeContext,intentContract:sealed.intentContract,intentContractDigest:sealed.intentContractDigest,obligations:obligationsFromIntentContract(sealed.intentContract)});
    if(!purpose){
      if(actions.length||evidence.length)fail("ORIGINAL_PURPOSE_NOT_APPLICABLE");
      return freeze({baseline,artifactDigests:artifacts,verifiedOriginalSubjectEdges:edges,observations,problems});
    }
    if(!actions.length&&!evidence.length){
      if(firstLater!==Number.MAX_SAFE_INTEGER)fail("ORIGINAL_ACTION_MISSING");
      return freeze({baseline,artifactDigests:artifacts,verifiedOriginalSubjectEdges:edges,originalSubjectContext:purposeContext,observations,problems});
    }
    const minimal = deriveRepositoryPureAssertionContext(sealed);
    if (actions.some(event => event.actor.kind !== "kernel" || event.actor.id !== "jevyr.bone" || event.stage !== "self_scan" || event.sequence >= firstLater)) fail("ORIGINAL_ACTION_ORDER");
    if (actions.length === 1 && actions[0]!.payload.status === "denied" && !actions[0]!.payload.artifactDigests?.length && actions[0]!.payload.resource === undefined && !evidence.length) {
      // Purpose remains bound to the authenticated unchanged original even
      // when no evaluator can run. Scope metadata grants no evidence edge.
      return freeze({ baseline, artifactDigests: artifacts, verifiedOriginalSubjectEdges: edges, originalSubjectContext:{sealedCase:sealed,kernelDigest}, observations, problems });
    }
    if (actions.length !== 2 || actions[0]!.payload.status !== "started" || !["completed","failed"].includes(actions[1]!.payload.status)
      || actions[0]!.payload.actionId !== actions[1]!.payload.actionId || actions[0]!.sequence >= actions[1]!.sequence || actions[0]!.payload.artifactDigests?.length
      || actions[0]!.payload.resource !== undefined || evidence.length > 1) fail("ORIGINAL_ACTION_MEMBERSHIP");
    const terminal = actions[1]!, digests = terminal.payload.artifactDigests;
    if (!digests || digests.length !== 1 || !isSha256Digest(digests[0])) fail("ORIGINAL_CERTIFICATE_REFERENCE");
    const bytes = await resolve(digests[0]);
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES || sha256Digest(bytes) !== digests[0]) fail("ORIGINAL_CERTIFICATE_RESOLUTION");
    const certificate = decodeOriginalSubjectCertificate(bytes);
    const expected = { caseId: sealed.caseId, caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest, captureDigest: sealed.subjectMaterialCaptureDigest,
      subjectId: minimal.subject.subjectId, obligationId: minimal.intentContract.criticalObligations[0]!.id, kernelDigest };
    for (const [key,value] of Object.entries(expected)) if ((certificate as unknown as Record<string,unknown>)[key] !== value) fail("ORIGINAL_CERTIFICATE_CASE_BINDING");
    const assets = context.assets ?? await originalSubjectProducerAssets(), source = restrictedSource(certificate, assets);
    const replay = await replayRepositoryPureExecution({ ...source, sealedCase: sealed, sealEnvelope: context.sealEnvelope, trustedCaseKeys: context.trustedCaseKeys, policyDescriptor, assets });
    if (!replay.authenticatedCase || !replay.consistent) fail(`ORIGINAL_PHYSICAL_REPLAY_${replay.problems[0] ?? "FAILED"}`);
    const receipt = parseJsonBytes(source.artifacts["receipt.json"]!) as unknown as RepositoryPureExecutionReceipt;
    const reservation=originalSubjectExecutionLimits(sealed,policyDescriptor),expectedLimits={...reservation.resourceLimits,timeoutMs:reservation.timeoutMs};
    // The host-monotonic receipt includes package preparation and cleanup, not
    // only the child process. A narrower sealed frontier still bounds that sum.
    const envelope=sealed.searchEnvelope.profile.resources,frontier=boundPolicy.assayFrontier as {aggregateLimits:{maxForgeWallMillis:number}};
    const elapsedWallLimit=Math.min(envelope.maxWallMillis,envelope.maxForgeWallMillis,envelope.maxSingleInvocationMillis,frontier.aggregateLimits.maxForgeWallMillis);
    if (Object.values(expectedLimits).some(value => !natural(value) || value < 1) || !same(receipt.resourceLimits, expectedLimits)
      || receipt.invocationId !== terminal.payload.actionId || bytes.length > expectedLimits.maxArtifactBytes || receipt.resources.wallMillis > elapsedWallLimit) fail("ORIGINAL_INITIAL_ENVELOPE_MISMATCH");
    const r = receipt.resources, resource = { wallMillis: r.wallMillis, bytesWritten: r.writableBytes, ...(r.cpuMeasurement === "MEASURED" ? {cpuMillis:r.cpuMillis} : {}) };
    if (terminal.payload.status !== "completed" || !same(terminal.payload.resource, resource)) fail("ORIGINAL_ACTION_RESOURCE_MISMATCH");
    if (events.some(event => event.kind === "candidate.status" && event.payload.artifactDigests?.includes(digests[0]!)
      || event.kind === "evidence.observed" && event.payload.contentDigest === digests[0] && event.payload.evidenceType !== "original_subject_assertions")) fail("ORIGINAL_CERTIFICATE_RELABELED");
    if (replay.outcome === "unavailable") { if (evidence.length) fail("ORIGINAL_UNAVAILABLE_HAS_EDGE"); }
    else {
      const event = evidence[0], kind = replay.outcome === "match" ? "supports" : "refutes";
      if (!event || event.sequence <= terminal.sequence || event.sequence >= firstLater || event.actor.kind !== "kernel" || event.actor.id !== "jevyr.bone" || event.stage !== "self_scan"
        || event.payload.contentDigest !== digests[0] || event.payload.candidateId !== undefined || event.payload.assayId !== undefined || event.payload.formalProof !== undefined || event.payload.audit !== undefined
        || !same(event.payload[kind], [certificate.obligationId]) || event.payload[kind === "supports" ? "refutes" : "supports"] !== undefined
        || !same(event.payload.originalSubject, { protocol:"jevyr.original-subject-assertion-binding/1", subjectId:certificate.subjectId, obligationId:certificate.obligationId,
          captureDigest:certificate.captureDigest, certificateDigest:digests[0], executionReceiptDigest:certificate.executionReceiptDigest, kernelDigest })) fail("ORIGINAL_EVIDENCE_EDGE_MISMATCH");
      edges.push({eventDigest:event.eventDigest,evidenceId:event.payload.evidenceId,contentDigest:event.payload.contentDigest,targetId:certificate.obligationId,kind});
    }
    baseline = {forgeWallMillis:r.wallMillis,measuredForgeCpuMillis:r.cpuMillis??0,cpuMeasurements:r.cpuMeasurement==="MEASURED"?1:0,cpuUnmeasured:r.cpuMeasurement==="UNMEASURED",workspaceUnmeasured:r.workspaceMeasurement==="CONSERVATIVE_CEILING",writableBytes:r.writableBytes,writableInodes:r.writableInodes,artifactBytes:bytes.length,totalAssayCost:0};
    artifacts.push(digests[0]!);observations.push({sequence:terminal.sequence,certificateDigest:digests[0]!,executionReceiptDigest:certificate.executionReceiptDigest,outcome:replay.outcome,resources:{...r,artifactBytes:bytes.length}});
    originalSubjectContext={sealedCase:sealed,kernelDigest};
  } catch(error) { problems.push({sequence:actions.at(-1)?.sequence??evidence[0]?.sequence??0,message:error instanceof Error && /^[A-Z0-9_]{4,160}$/u.test(error.message)?error.message:"ORIGINAL_CERTIFICATE_REPLAY_REFUSED"}); }
  return freeze({baseline,artifactDigests:artifacts,verifiedOriginalSubjectEdges:problems.length?[]:edges,...(originalSubjectContext?{originalSubjectContext}:{}),observations,problems});
}
