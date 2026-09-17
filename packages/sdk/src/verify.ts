import {
  CASE_EVENT_JSON_SCHEMA,
  LIFECYCLE_STAGES,
  assertIntentContractShape,
  validateCaseEventShape,
  validateSealedCase,
  validateSealReceipt,
  validateSignedRecord,
  validateTerminalReceipt,
  type CaseEvent,
  type IntentContract,
  type LiveCaseStatus,
  type LiveEventBatch,
  type SealedCase,
  type SealReceipt,
  type SignedRecord,
  type TerminalReceipt,
} from "@jevyr/protocol";
import { canonicalJson, recomputeEventDigest, sha256Digest } from "./digest.js";
import { JevyrContinuityError } from "./errors.js";
import type {
  ArtifactList,
  ArtifactMeta,
  CasePolicyDescriptor,
  DescriptorArtifact,
  JevyrReadiness,
  ReadinessBlockerCode,
  ReadinessProbe,
} from "./types.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const STAGES = new Set<string>(LIFECYCLE_STAGES);
const KINDS = new Set<string>(CASE_EVENT_JSON_SCHEMA.properties.kind.enum);
const ACTORS = new Set<string>(CASE_EVENT_JSON_SCHEMA.properties.actor.properties.kind.enum);
const LIFECYCLES = new Set(["queued", "running", "crystallized", "terminated", "invalid"]);
const STAGE_STATUSES = new Set(["entered", "working", "completed", "failed", "skipped"]);
const FORBIDDEN_TRACE_KEYS = new Set(["chainofthought", "chain_of_thought", "reasoningtrace", "reasoning_trace", "scratchpad", "hiddenstate", "hidden_state", "internalthoughts", "internal_thoughts"]);
const ARTIFACT_ID = /^artifact_[a-f0-9]{24}$/u;
const ARTIFACT_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*charset=[a-z0-9._-]+)?$/iu;
const READINESS_PROBE_STATUSES = new Set(["available", "unavailable", "failed", "timed-out", "invalid"]);
const READINESS_MODEL_STATUSES = new Set(["ready", "template-only", "unavailable"]);
const READINESS_MODEL_MODES = new Set(["template-only", "local", "remote", "mixed", "configured-unavailable"]);
const READINESS_TRANSPORTS = new Set(["process", "http", "in-process", "a2a"]);
const READINESS_NETWORKS = new Set(["none", "loopback", "provider", "unrestricted"]);
const READINESS_FORGE_MODES = new Set(["docker", "trusted-host", "observe-only", "opaque"]);
const READINESS_FORGE_STATUSES = new Set(["ready", "substrate-unavailable", "execution-disabled", "probe-unavailable", "observe-only", "diagnostic-only", "opaque"]);
const READINESS_EVIDENCE_AUTHORITIES = new Set(["verified-docker", "diagnostic-only", "none"]);
const READINESS_SUBSTRATE_STATUSES = new Set(["resolved", "unavailable", "not-applicable", "opaque"]);
const READINESS_BLOCKER_DETAILS: Readonly<Record<ReadinessBlockerCode, string>> = Object.freeze({
  "models.template-only": "Only RuleMind's deterministic templates are configured; no reasoning model can generate independent candidates.",
  "models.reasoning-unavailable": "Reasoning models are configured, but none passed a live availability probe.",
  "forge.observe-only": "Forge is observation-only and cannot execute an assay.",
  "forge.diagnostic-only": "Trusted-host Forge output is diagnostic and cannot become verdict evidence.",
  "forge.opaque": "The embedder-defined Forge has no verifiable Docker evidence authority.",
  "forge.substrate-unavailable": "The Docker image was not resolved to an immutable local image ID at daemon startup.",
  "forge.execution-disabled": "The configured Forge capability cannot execute tools.",
  "forge.probe-unavailable": "The startup-sealed Docker substrate did not pass its current availability probe.",
  "assays.empty": "The compile-admitted Assay Frontier is empty; no candidate can enter a configured experiment.",
});

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new JevyrContinuityError(`${label} contains unknown field ${extra}`);
}

function strictExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new JevyrContinuityError(`${label} contains missing or unknown fields`);
  }
}

function boundedReadinessId(value: unknown, label: string, maximum = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertReadinessProbe(value: unknown, label: string): ReadinessProbe {
  if (!object(value)) throw new JevyrContinuityError(`${label} is not an object`);
  strictExactKeys(value, ["status", "observedAt", "latencyMs"], label);
  if (!READINESS_PROBE_STATUSES.has(String(value.status))
    || !canonicalTimestamp(value.observedAt)
    || !Number.isSafeInteger(value.latencyMs)
    || (value.latencyMs as number) < 0) {
    throw new JevyrContinuityError(`${label} is invalid`);
  }
  return value as unknown as ReadinessProbe;
}

/** Strictly validates the sanitized infrastructure-readiness endpoint. */
export function assertReadiness(value: unknown): JevyrReadiness {
  if (!object(value)) throw new JevyrContinuityError("Readiness endpoint returned a non-object");
  strictExactKeys(
    value,
    ["protocol", "ready", "scope", "observedAt", "semanticContinuation", "models", "forge", "assays", "blockers"],
    "Readiness report",
  );
  if (value.protocol !== "jevyr.readiness/1"
    || typeof value.ready !== "boolean"
    || value.scope !== "infrastructure"
    || !canonicalTimestamp(value.observedAt)
    || value.semanticContinuation !== false) {
    throw new JevyrContinuityError("Readiness report has an invalid envelope");
  }

  if (!object(value.models)) throw new JevyrContinuityError("Readiness models are not an object");
  strictExactKeys(
    value.models,
    ["status", "mode", "configuredCount", "availableCount", "reasoningConfiguredCount", "reasoningAvailableCount", "adapters"],
    "Readiness models",
  );
  if (!READINESS_MODEL_STATUSES.has(String(value.models.status))
    || !READINESS_MODEL_MODES.has(String(value.models.mode))
    || !Array.isArray(value.models.adapters)
    || value.models.adapters.length > 256) {
    throw new JevyrContinuityError("Readiness models have an invalid summary");
  }
  const modelIds = new Set<string>();
  const adapters = value.models.adapters.map((entry, index) => {
    if (!object(entry)) throw new JevyrContinuityError(`Readiness model ${index} is not an object`);
    strictExactKeys(entry, ["id", "role", "configured", "transport", "network", "probe"], `Readiness model ${index}`);
    if (!boundedReadinessId(entry.id, `Readiness model ${index} id`)
      || (entry.role !== "template" && entry.role !== "reasoning")
      || entry.configured !== true
      || !READINESS_TRANSPORTS.has(String(entry.transport))
      || !READINESS_NETWORKS.has(String(entry.network))) {
      throw new JevyrContinuityError(`Readiness model ${index} is invalid`);
    }
    if (modelIds.has(entry.id)) throw new JevyrContinuityError("Readiness models repeat an adapter id");
    modelIds.add(entry.id);
    return {
      id: entry.id,
      role: entry.role,
      network: entry.network,
      probe: assertReadinessProbe(entry.probe, `Readiness model ${index} probe`),
    };
  });
  if (adapters.some((entry, index) => index > 0 && adapters[index - 1]!.id.localeCompare(entry.id) >= 0)) {
    throw new JevyrContinuityError("Readiness model adapters are not canonically ordered");
  }
  const reasoning = adapters.filter((entry) => entry.role === "reasoning");
  const available = adapters.filter((entry) => entry.probe.status === "available");
  const availableReasoning = reasoning.filter((entry) => entry.probe.status === "available");
  const localAvailable = availableReasoning.some((entry) => entry.network === "none" || entry.network === "loopback");
  const remoteAvailable = availableReasoning.some((entry) => entry.network === "provider" || entry.network === "unrestricted");
  const expectedModelStatus = availableReasoning.length > 0
    ? "ready"
    : reasoning.length === 0
      ? "template-only"
      : "unavailable";
  const expectedModelMode = reasoning.length === 0
    ? "template-only"
    : availableReasoning.length === 0
      ? "configured-unavailable"
      : localAvailable && remoteAvailable
        ? "mixed"
        : remoteAvailable
          ? "remote"
          : "local";
  if (value.models.configuredCount !== adapters.length
    || value.models.availableCount !== available.length
    || value.models.reasoningConfiguredCount !== reasoning.length
    || value.models.reasoningAvailableCount !== availableReasoning.length
    || value.models.status !== expectedModelStatus
    || value.models.mode !== expectedModelMode) {
    throw new JevyrContinuityError("Readiness model counts or derived state are inconsistent");
  }

  if (!object(value.forge)) throw new JevyrContinuityError("Readiness Forge is not an object");
  strictExactKeys(
    value.forge,
    ["id", "mode", "configured", "status", "canExecuteTools", "network", "probe", "evidenceAuthority", "substrate", "usable"],
    "Readiness Forge",
  );
  if (!boundedReadinessId(value.forge.id, "Readiness Forge id")
    || !READINESS_FORGE_MODES.has(String(value.forge.mode))
    || value.forge.configured !== true
    || !READINESS_FORGE_STATUSES.has(String(value.forge.status))
    || typeof value.forge.canExecuteTools !== "boolean"
    || !READINESS_NETWORKS.has(String(value.forge.network))
    || !READINESS_EVIDENCE_AUTHORITIES.has(String(value.forge.evidenceAuthority))
    || typeof value.forge.usable !== "boolean") {
    throw new JevyrContinuityError("Readiness Forge has invalid metadata");
  }
  const forgeProbe = assertReadinessProbe(value.forge.probe, "Readiness Forge probe");
  if (!object(value.forge.substrate)) throw new JevyrContinuityError("Readiness Forge substrate is not an object");
  strictExactKeys(value.forge.substrate, ["status", "immutableImageId"], "Readiness Forge substrate");
  if (!READINESS_SUBSTRATE_STATUSES.has(String(value.forge.substrate.status))
    || (value.forge.substrate.immutableImageId !== null && !digest(value.forge.substrate.immutableImageId))) {
    throw new JevyrContinuityError("Readiness Forge substrate is invalid");
  }
  let expectedForgeStatus: JevyrReadiness["forge"]["status"];
  let expectedAuthority: JevyrReadiness["forge"]["evidenceAuthority"];
  if (value.forge.mode === "observe-only") {
    expectedForgeStatus = "observe-only";
    expectedAuthority = "none";
    if (value.forge.substrate.status !== "not-applicable" || value.forge.substrate.immutableImageId !== null) {
      throw new JevyrContinuityError("Observe-only Forge exposes an impossible substrate");
    }
  } else if (value.forge.mode === "trusted-host") {
    expectedForgeStatus = "diagnostic-only";
    expectedAuthority = "diagnostic-only";
    if (value.forge.substrate.status !== "not-applicable" || value.forge.substrate.immutableImageId !== null) {
      throw new JevyrContinuityError("Trusted-host Forge exposes an impossible substrate");
    }
  } else if (value.forge.mode === "opaque") {
    expectedForgeStatus = "opaque";
    expectedAuthority = "diagnostic-only";
    if (value.forge.substrate.status !== "opaque" || value.forge.substrate.immutableImageId !== null) {
      throw new JevyrContinuityError("Opaque Forge exposes an impossible substrate");
    }
  } else {
    expectedAuthority = "verified-docker";
    if (value.forge.substrate.status === "resolved") {
      if (!digest(value.forge.substrate.immutableImageId)) {
        throw new JevyrContinuityError("Resolved Docker Forge has no immutable image id");
      }
      expectedForgeStatus = !value.forge.canExecuteTools
        ? "execution-disabled"
        : forgeProbe.status !== "available"
          ? "probe-unavailable"
          : "ready";
    } else {
      if (value.forge.substrate.status !== "unavailable" || value.forge.substrate.immutableImageId !== null) {
        throw new JevyrContinuityError("Docker Forge exposes an impossible substrate state");
      }
      expectedForgeStatus = "substrate-unavailable";
    }
  }
  if (value.forge.status !== expectedForgeStatus
    || value.forge.evidenceAuthority !== expectedAuthority
    || value.forge.usable !== (expectedForgeStatus === "ready")) {
    throw new JevyrContinuityError("Readiness Forge derived state is inconsistent");
  }

  if (!object(value.assays)) throw new JevyrContinuityError("Readiness assays are not an object");
  strictExactKeys(value.assays, ["status", "mode", "count", "ids", "frontierDigest", "caseApplicability"], "Readiness assays");
  if ((value.assays.status !== "admitted" && value.assays.status !== "empty")
    || !["empty", "comparative-only", "case-binding-configured", "mixed"].includes(String(value.assays.mode))
    || !Number.isSafeInteger(value.assays.count)
    || (value.assays.count as number) < 0
    || !Array.isArray(value.assays.ids)
    || value.assays.ids.length > 256
    || !digest(value.assays.frontierDigest)
    || value.assays.caseApplicability !== "case-dependent") {
    throw new JevyrContinuityError("Readiness assays have invalid metadata");
  }
  const assayIds = new Set<string>();
  const assayEntries = value.assays.ids;
  for (const [index, id] of assayEntries.entries()) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id) || assayIds.has(id)) {
      throw new JevyrContinuityError(`Readiness assay id ${index} is invalid or repeated`);
    }
    assayIds.add(id);
  }
  if (assayEntries.some((id, index) => index > 0 && String(assayEntries[index - 1]).localeCompare(String(id)) >= 0)
    || value.assays.count !== assayEntries.length
    || value.assays.status !== (assayEntries.length > 0 ? "admitted" : "empty")
    || (assayEntries.length === 0 && value.assays.mode !== "empty")
    || (assayEntries.length > 0 && value.assays.mode === "empty")) {
    throw new JevyrContinuityError("Readiness assay counts or derived state are inconsistent");
  }

  if (!Array.isArray(value.blockers) || value.blockers.length > 3) {
    throw new JevyrContinuityError("Readiness blockers are invalid");
  }
  const expectedCodes: ReadinessBlockerCode[] = [];
  if (expectedModelStatus === "template-only") expectedCodes.push("models.template-only");
  else if (expectedModelStatus === "unavailable") expectedCodes.push("models.reasoning-unavailable");
  if (expectedForgeStatus !== "ready") {
    expectedCodes.push(expectedForgeStatus === "observe-only"
      ? "forge.observe-only"
      : expectedForgeStatus === "diagnostic-only"
        ? "forge.diagnostic-only"
        : expectedForgeStatus === "opaque"
          ? "forge.opaque"
          : expectedForgeStatus === "substrate-unavailable"
            ? "forge.substrate-unavailable"
            : expectedForgeStatus === "execution-disabled"
              ? "forge.execution-disabled"
              : "forge.probe-unavailable");
  }
  if (value.assays.status === "empty") expectedCodes.push("assays.empty");
  for (const [index, raw] of value.blockers.entries()) {
    if (!object(raw)) throw new JevyrContinuityError(`Readiness blocker ${index} is not an object`);
    strictExactKeys(raw, ["code", "component", "detail"], `Readiness blocker ${index}`);
    const expectedCode = expectedCodes[index];
    const expectedComponent = expectedCode?.split(".", 1)[0];
    if (raw.code !== expectedCode
      || raw.component !== expectedComponent
      || typeof raw.detail !== "string"
      || raw.detail !== (expectedCode === undefined ? undefined : READINESS_BLOCKER_DETAILS[expectedCode])) {
      throw new JevyrContinuityError("Readiness blockers do not exactly explain the derived state");
    }
  }
  if (value.blockers.length !== expectedCodes.length || value.ready !== (expectedCodes.length === 0)) {
    throw new JevyrContinuityError("Readiness ready bit does not match its blockers");
  }
  return value as unknown as JevyrReadiness;
}

/** Validates the complete immutable Case whose identity is committed by a SealReceipt. */
export function assertSealedCase(value: unknown): SealedCase {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    throw new JevyrContinuityError("SealedCase is not cloneable JSON data");
  }
  const result = validateSealedCase(snapshot);
  if (!result.ok || result.value === undefined) {
    throw new JevyrContinuityError(
      `SealedCase violates the canonical contract: ${result.problems.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
    );
  }
  return result.value;
}

function basenameOnly(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").at(-1) ?? "artifact";
  return base.replace(/[\u0000-\u001f\u007f"]/gu, "_") || "artifact";
}

/** Strictly validates one content-addressed artifact descriptor. */
export function assertArtifactMeta(
  value: unknown,
  expected: { readonly caseId?: string; readonly artifactId?: string } = {},
): ArtifactMeta {
  if (!object(value)) throw new JevyrContinuityError("Artifact metadata is not an object");
  strictExactKeys(value, ["protocol", "id", "caseId", "name", "mediaType", "size", "digest", "createdAt"], "Artifact metadata");
  if (
    value.protocol !== "jevyr.artifact/1"
    || typeof value.id !== "string"
    || !ARTIFACT_ID.test(value.id)
    || typeof value.caseId !== "string"
    || !value.caseId
    || typeof value.name !== "string"
    || value.name.length < 1
    || value.name.length > 255
    || basenameOnly(value.name) !== value.name
    || typeof value.mediaType !== "string"
    || value.mediaType.length > 200
    || !ARTIFACT_MEDIA_TYPE.test(value.mediaType)
    || !Number.isSafeInteger(value.size)
    || (value.size as number) < 0
    || !digest(value.digest)
    || value.id !== `artifact_${value.digest.slice("sha256:".length, "sha256:".length + 24)}`
    || typeof value.createdAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.createdAt)
    || Number.isNaN(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new JevyrContinuityError("Artifact contains invalid metadata");
  }
  if (expected.caseId !== undefined && value.caseId !== expected.caseId) {
    throw new JevyrContinuityError("Artifact metadata crossed a Case boundary");
  }
  if (expected.artifactId !== undefined && value.id !== expected.artifactId) {
    throw new JevyrContinuityError("Artifact metadata does not match the requested artifact");
  }
  return value as unknown as ArtifactMeta;
}

/** Strictly validates a complete Case artifact-index response. */
export function assertArtifactList(value: unknown, expectedCaseId: string): ArtifactList {
  if (!object(value)) throw new JevyrContinuityError("Artifact endpoint returned a non-object index");
  strictExactKeys(value, ["protocol", "caseId", "artifacts"], "Artifact index");
  if (value.protocol !== "jevyr.artifacts/1" || value.caseId !== expectedCaseId || !Array.isArray(value.artifacts)) {
    throw new JevyrContinuityError("Artifact endpoint returned an invalid Case index");
  }
  const ids = new Set<string>();
  const artifacts = value.artifacts.map((entry) => {
    const artifact = assertArtifactMeta(entry, { caseId: expectedCaseId });
    if (ids.has(artifact.id)) throw new JevyrContinuityError(`Artifact index repeats ${artifact.id}`);
    ids.add(artifact.id);
    return artifact;
  });
  return { protocol: "jevyr.artifacts/1", caseId: expectedCaseId, artifacts };
}

/** Rehashes and strictly validates one persisted provenance descriptor. */
export async function assertDescriptorArtifact(
  value: unknown,
  expected: {
    readonly kind?: DescriptorArtifact["kind"];
    readonly digest?: string;
  } = {},
): Promise<DescriptorArtifact> {
  if (!object(value)) throw new JevyrContinuityError("Descriptor artifact is not an object");
  strictExactKeys(value, ["protocol", "kind", "digest", "descriptor"], "Descriptor artifact");
  if (
    value.protocol !== "jevyr.descriptor-artifact/1"
    || !["policy", "genome", "search"].includes(String(value.kind))
    || !digest(value.digest)
  ) {
    throw new JevyrContinuityError("Descriptor artifact has invalid identity metadata");
  }
  let computed: string;
  try {
    computed = await sha256Digest(canonicalJson(value.descriptor));
  } catch {
    throw new JevyrContinuityError("Descriptor artifact does not contain canonical JSON data");
  }
  if (computed !== value.digest) {
    throw new JevyrContinuityError("Descriptor artifact bytes do not match its SHA-256 digest");
  }
  if (expected.kind !== undefined && value.kind !== expected.kind) {
    throw new JevyrContinuityError("Descriptor artifact has the wrong provenance kind");
  }
  if (expected.digest !== undefined && value.digest !== expected.digest) {
    throw new JevyrContinuityError("Descriptor artifact digest does not match the authenticated reference");
  }
  if (value.kind === "policy") {
    if (!object(value.descriptor)) {
      throw new JevyrContinuityError("Policy descriptor payload is not an object");
    }
    strictExactKeys(
      value.descriptor,
      ["protocol", "version", "policy", "subjectSnapshots"],
      "Policy descriptor payload",
    );
    if (
      value.descriptor.protocol !== "jevyr.policy-descriptor/1"
      || typeof value.descriptor.version !== "string"
      || value.descriptor.version.length === 0
      || !object(value.descriptor.policy)
      || !object(value.descriptor.subjectSnapshots)
    ) {
      throw new JevyrContinuityError("Policy descriptor payload has an invalid canonical envelope");
    }
  }
  return value as unknown as DescriptorArtifact;
}

/** Validates the daemon's Case-scoped descriptor binding and its exact content. */
export async function assertCasePolicyDescriptor(
  value: unknown,
  expectedCaseId: string,
): Promise<CasePolicyDescriptor> {
  if (!object(value)) throw new JevyrContinuityError("Policy descriptor endpoint returned a non-object");
  strictExactKeys(
    value,
    ["protocol", "caseId", "caseDigest", "runDigest", "policyDigest", "artifact"],
    "Case policy descriptor",
  );
  if (
    value.protocol !== "jevyr.case-policy-descriptor/1"
    || value.caseId !== expectedCaseId
    || !digest(value.caseDigest)
    || !digest(value.runDigest)
    || !digest(value.policyDigest)
  ) {
    throw new JevyrContinuityError("Policy descriptor endpoint crossed or malformed its Case binding");
  }
  const artifact = await assertDescriptorArtifact(value.artifact, {
    kind: "policy",
    digest: value.policyDigest,
  });
  return {
    protocol: "jevyr.case-policy-descriptor/1",
    caseId: expectedCaseId,
    caseDigest: value.caseDigest,
    runDigest: value.runDigest,
    policyDigest: value.policyDigest,
    artifact: artifact as CasePolicyDescriptor["artifact"],
  };
}

/** Binds a content-verified policy descriptor to a separately authenticated Record. */
export function assertPolicyDescriptorRecordBinding(
  binding: CasePolicyDescriptor,
  recordValue: unknown,
): CasePolicyDescriptor {
  const record = assertRecordPayload(recordValue);
  if (
    binding.caseDigest !== record.caseDigest
    || binding.runDigest !== record.runDigest
    || binding.policyDigest !== record.policyDigest
    || binding.artifact.digest !== record.policyDigest
  ) {
    throw new JevyrContinuityError("Policy descriptor does not match the authenticated Record identity");
  }
  return binding;
}

function containsForbiddenTrace(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenTrace);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_TRACE_KEYS.has(key.toLowerCase()) || containsForbiddenTrace(child));
}

/**
 * Validates the complete, versioned IntentContract and both of its content
 * digests. This authenticates no signer by itself; use verifiedIntentContract
 * to bind the returned digest to an authenticated SealReceipt.
 */
export function assertIntentContractPayload(value: unknown): IntentContract {
  try {
    assertIntentContractShape(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "IntentContract validation failed";
    throw new JevyrContinuityError(detail);
  }
  return value;
}

export async function assertCaseEvent(
  value: unknown,
  expected: {
    sequence: number;
    priorDigest?: string | null;
    caseDigest?: string;
    runDigest?: string;
  },
): Promise<CaseEvent> {
  if (!object(value)) throw new JevyrContinuityError("Live transport emitted a non-object event");
  const shape = validateCaseEventShape(value);
  if (!shape.ok) {
    throw new JevyrContinuityError(
      `Live event violates the canonical payload contract: ${shape.problems.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
    );
  }
  exactKeys(value, ["protocol", "caseDigest", "runDigest", "sequence", "priorDigest", "eventDigest", "observedAt", "stage", "kind", "actor", "payload"], "CaseEvent");
  if (value.protocol !== "jevyr.event/1") throw new JevyrContinuityError("Live event uses an unsupported protocol");
  if (!digest(value.caseDigest) || !digest(value.runDigest) || !digest(value.eventDigest)) throw new JevyrContinuityError("Live event contains an invalid digest");
  if (!Number.isSafeInteger(value.sequence) || value.sequence !== expected.sequence || expected.sequence < 1) {
    throw new JevyrContinuityError(`Event gap: expected ${expected.sequence}, received ${String(value.sequence)}`);
  }
  if (value.priorDigest !== null && !digest(value.priorDigest)) throw new JevyrContinuityError("Live event contains an invalid priorDigest");
  if (expected.priorDigest !== undefined && value.priorDigest !== expected.priorDigest) throw new JevyrContinuityError("Event priorDigest does not match the verified cursor head");
  if (expected.caseDigest && value.caseDigest !== expected.caseDigest) throw new JevyrContinuityError("caseDigest changed inside one stream");
  if (expected.runDigest && value.runDigest !== expected.runDigest) throw new JevyrContinuityError("runDigest changed inside one stream");
  if (!canonicalTimestamp(value.observedAt)) throw new JevyrContinuityError("Live event contains an invalid observedAt timestamp");
  if (!STAGES.has(String(value.stage)) || !KINDS.has(String(value.kind))) throw new JevyrContinuityError("Live event contains an unknown stage or kind");
  if (!object(value.actor) || typeof value.actor.id !== "string" || !value.actor.id || !ACTORS.has(String(value.actor.kind))) throw new JevyrContinuityError("Live event contains an invalid actor");
  if (!object(value.payload)) throw new JevyrContinuityError("Live event payload must be an object");
  if (containsForbiddenTrace(value.payload)) throw new JevyrContinuityError("Live event exposes a forbidden private reasoning field");
  const event = value as unknown as CaseEvent;
  if (event.eventDigest !== await recomputeEventDigest(event)) throw new JevyrContinuityError("Event content does not match eventDigest");
  return event;
}

export async function assertLiveEventBatch(value: unknown, requestedAfter: number): Promise<LiveEventBatch> {
  if (!object(value) || value.protocol !== "jevyr.live/1") throw new JevyrContinuityError("Event endpoint did not return jevyr.live/1");
  exactKeys(value, ["protocol", "caseDigest", "runDigest", "afterSequence", "throughSequence", "headDigest", "caughtUp", "events", "polledAt"], "LiveEventBatch");
  if (!digest(value.caseDigest) || !digest(value.runDigest)) throw new JevyrContinuityError("Event batch contains invalid case or run digests");
  if (value.afterSequence !== requestedAfter || !Number.isSafeInteger(value.throughSequence) || (value.throughSequence as number) < requestedAfter) throw new JevyrContinuityError("Event batch cursor does not match the request");
  if (value.headDigest !== null && !digest(value.headDigest)) throw new JevyrContinuityError("Event batch contains an invalid headDigest");
  if (typeof value.caughtUp !== "boolean" || !Array.isArray(value.events) || !canonicalTimestamp(value.polledAt)) throw new JevyrContinuityError("Event batch has an invalid envelope");
  let sequence = requestedAfter;
  let prior: string | null | undefined = requestedAfter === 0 ? null : undefined;
  for (const raw of value.events) {
    const event = await assertCaseEvent(raw, {
      sequence: sequence + 1,
      ...(prior === undefined ? {} : { priorDigest: prior }),
      caseDigest: value.caseDigest,
      runDigest: value.runDigest,
    });
    sequence = event.sequence;
    prior = event.eventDigest;
  }
  if (value.throughSequence !== sequence) throw new JevyrContinuityError("throughSequence does not match the returned events");
  if (value.caughtUp && value.events.length > 0 && value.headDigest !== prior) throw new JevyrContinuityError("Caught-up batch headDigest does not match its final event");
  if (value.caughtUp && requestedAfter === 0 && value.events.length === 0 && value.headDigest !== null) throw new JevyrContinuityError("Empty ledger cannot expose a non-null headDigest");
  return value as unknown as LiveEventBatch;
}

export function assertSealReceipt(value: unknown): SealReceipt {
  if (!object(value) || value.protocol !== "jevyr.seal/1" || typeof value.caseId !== "string" || !value.caseId) throw new JevyrContinuityError("Cast endpoint did not return a canonical SealReceipt");
  exactKeys(value, ["protocol", "caseId", "submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "sealedAt", "policyVersion", "policyDigest", "genomeVersion", "genomeDigest", "searchDigest", "intentContractDigest"], "SealReceipt");
  if (![value.submissionDigest, value.subjectMaterialCaptureDigest, value.caseDigest, value.runDigest, value.policyDigest, value.genomeDigest, value.searchDigest, value.intentContractDigest].every(digest)) throw new JevyrContinuityError("SealReceipt contains an invalid digest");
  if (!canonicalTimestamp(value.sealedAt)) throw new JevyrContinuityError("SealReceipt sealedAt must be a canonical UTC timestamp with millisecond precision");
  if (typeof value.policyVersion !== "string" || !value.policyVersion || typeof value.genomeVersion !== "string" || !value.genomeVersion) throw new JevyrContinuityError("SealReceipt contains invalid provenance versions");
  const shape = validateSealReceipt(value);
  if (!shape.ok) {
    throw new JevyrContinuityError(
      `SealReceipt violates the canonical identity contract: ${shape.problems.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
    );
  }
  return value as unknown as SealReceipt;
}

export function assertCaseStatus(value: unknown): LiveCaseStatus {
  if (!object(value) || value.protocol !== "jevyr.status/1") throw new JevyrContinuityError("Status endpoint did not return jevyr.status/1");
  exactKeys(value, ["protocol", "caseDigest", "runDigest", "lifecycle", "stage", "stageStatus", "lastSequence", "headDigest", "updatedAt"], "LiveCaseStatus");
  if (!digest(value.caseDigest) || !digest(value.runDigest) || (value.headDigest !== null && !digest(value.headDigest))) throw new JevyrContinuityError("Status contains an invalid digest");
  if (!Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 0) throw new JevyrContinuityError("Status contains an invalid lastSequence");
  if (!LIFECYCLES.has(String(value.lifecycle)) || !STAGES.has(String(value.stage)) || !STAGE_STATUSES.has(String(value.stageStatus))) throw new JevyrContinuityError("Status contains an invalid lifecycle state");
  if (
    !canonicalTimestamp(value.updatedAt)
  ) throw new JevyrContinuityError("Status contains an invalid updatedAt timestamp");
  if (value.lastSequence === 0 && value.headDigest !== null) throw new JevyrContinuityError("Status with no events cannot expose a headDigest");
  if ((value.lastSequence as number) > 0 && value.headDigest === null) throw new JevyrContinuityError("Status with events must expose a headDigest");
  return value as unknown as LiveCaseStatus;
}

/** Validates a signed-closure payload before any cryptographic trust is assigned. */
export function assertTerminalReceipt(value: unknown): TerminalReceipt {
  const result = validateTerminalReceipt(value);
  if (!result.ok || result.value === undefined) {
    throw new JevyrContinuityError(
      `TerminalReceipt violates the canonical closure contract: ${result.problems.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
    );
  }
  return result.value;
}

/** Validates the public Record payload shape. This does not verify a signature. */
export function assertRecordPayload(value: unknown): SignedRecord {
  if (!object(value) || value.protocol !== "jevyr.record/1") throw new JevyrContinuityError("Record endpoint did not return jevyr.record/1");
  const shape = validateSignedRecord(value);
  if (!shape.ok) {
    throw new JevyrContinuityError(
      `Record violates the canonical field contract: ${shape.problems.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
    );
  }
  exactKeys(value, ["protocol", "caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest", "eventHeadDigest", "verdict", "reflex", "memoryInfluences", "crystallizedAt"], "SignedRecord");
  if (![value.caseDigest, value.runDigest, value.policyDigest, value.genomeDigest, value.searchDigest, value.intentContractDigest, value.eventHeadDigest].every(digest) || !object(value.verdict)) throw new JevyrContinuityError("Record contains invalid digests or verdict");
  if (!canonicalTimestamp(value.crystallizedAt) || !Array.isArray(value.memoryInfluences) || !object(value.reflex)) throw new JevyrContinuityError("Record contains invalid metadata");
  const verdictKeys = ["policyVersion", "intentContractDigest", "evidenceDigest", "integrity", "creation", "embodiment", "judgment", "feasibilityByCandidate", "basis"];
  if ("selectedCandidateId" in value.verdict) verdictKeys.push("selectedCandidateId");
  exactKeys(value.verdict, verdictKeys, "SignedRecord.verdict");
  if (
    typeof value.verdict.policyVersion !== "string" || !value.verdict.policyVersion ||
    !digest(value.verdict.intentContractDigest) || value.verdict.intentContractDigest !== value.intentContractDigest ||
    !digest(value.verdict.evidenceDigest) ||
    !["VALID", "INVALID"].includes(String(value.verdict.integrity)) ||
    !["CONCEIVED", "NO_SURVIVOR", "FAILED"].includes(String(value.verdict.creation)) ||
    !["BUILT", "NOT_BUILT", "FAILED"].includes(String(value.verdict.embodiment)) ||
    !["ACCEPT", "REJECT", "UNPROVEN", "NOT_APPLICABLE"].includes(String(value.verdict.judgment)) ||
    !object(value.verdict.feasibilityByCandidate) || !Array.isArray(value.verdict.basis) ||
    ("selectedCandidateId" in value.verdict && (typeof value.verdict.selectedCandidateId !== "string" || !value.verdict.selectedCandidateId))
  ) throw new JevyrContinuityError("Record verdict has an invalid structure or intent identity");
  exactKeys(value.reflex, ["loop", "reviewedEvidenceDigest", "intentContractDigest", "challengedNodeIds", "materialFindings", "decision", ...("audits" in value.reflex ? ["audits"] : [])], "SignedRecord.reflex");
  if (
    (value.reflex.loop !== 1 && value.reflex.loop !== 2) || !digest(value.reflex.reviewedEvidenceDigest) ||
    !digest(value.reflex.intentContractDigest) || value.reflex.intentContractDigest !== value.intentContractDigest ||
    !Array.isArray(value.reflex.challengedNodeIds) || !Array.isArray(value.reflex.materialFindings) ||
    !["confirm", "revise", "repeat_once"].includes(String(value.reflex.decision))
  ) throw new JevyrContinuityError("Record Reflex has an invalid structure");
  return value as unknown as SignedRecord;
}

/** @deprecated Use assertRecordPayload. Cryptographic authentication requires verifyRecordEnvelope. */
export function assertSignedRecord(value: unknown): SignedRecord {
  return assertRecordPayload(value);
}
