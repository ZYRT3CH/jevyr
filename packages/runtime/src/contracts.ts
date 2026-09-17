import {
  LIFECYCLE_STAGES,
  type CaseEvent,
  type DsseEnvelope,
  type JevyrVerdict,
  type LifecycleStage,
  type JsonValue,
  type SealedCase,
  type SignedRecord,
  type SubjectReference,
} from "@jevyr/protocol";
import type { ExactByteCapture, ForgeOracleObservation } from "./typed-oracles.js";
import type { NurseryInvocationUsage } from "@jevyr/growth";
import type { SubjectTextProjection } from "./subject-materials.js";
import type { ExperimentCapability } from "./experiment-capability.js";
import type { InvestigatorToolReceipt } from "./investigator-tools.js";
import type { SubjectContext } from "./subject-context.js";

/** The runtime uses the protocol lifecycle directly; there is no second stage vocabulary. */
export const JEVYR_STAGES = LIFECYCLE_STAGES;
export type JevyrStage = LifecycleStage;
export type AdapterKind = "mind" | "tool" | "peer";
export type AdapterTrust = "inner" | "quarantined" | "local-deterministic";

export interface CapabilityCard {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly displayName: string;
  readonly version: string;
  readonly transport: "process" | "http" | "in-process" | "a2a";
  readonly trust: AdapterTrust;
  readonly modalities: readonly ("text" | "files" | "commands" | "structured-data")[];
  readonly network: "none" | "loopback" | "provider" | "unrestricted";
  readonly canExecuteTools: boolean;
  readonly deterministic: boolean;
  readonly limits?: Readonly<Record<string, number | string | boolean>>;
}

export interface ProbeResult {
  readonly available: boolean;
  readonly observedAt: string;
  readonly latencyMs: number;
  readonly version?: string;
  readonly detail: string;
}

/** The adapter view is the canonical seal plus the digest of the concrete runtime policy. */
export interface SealedCaseContext extends SealedCase {
  readonly policyDigest: string;
}

/** @deprecated Use the protocol-native SubjectReference name. */
export type SubjectDescriptor = SubjectReference;

export type ContributionKind =
  | "interpretation"
  | "claim"
  | "observation"
  | "candidate"
  | "challenge"
  | "test-plan"
  | "repair"
  | "reflex";

export interface PublicContribution {
  readonly id: string;
  readonly kind: ContributionKind;
  /** A concise, inspectable assertion. Never hidden reasoning or chain-of-thought. */
  readonly summary: string;
  readonly body?: string;
  readonly parentIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly feasibility?: "BUILDABLE_NOW" | "BRIDGEABLE" | "LAWFUL_BUT_OPEN" | "CONTRADICTED";
  /** Advisory only. It is never a verdict weight by itself. */
  readonly confidence?: number;
  readonly evidenceRefs?: readonly string[];
  /** Untrusted model JSON. The orchestrator must compile or erase it immediately. */
  readonly candidateBlueprintSource?: JsonValue;
  /** Digest of a compiled, authority-free blueprint admitted by the runtime. */
  readonly blueprintDigest?: string;
}

export interface MindRequest {
  /** Bounded feedback method only; it grants no new execution or oracle capability. */
  readonly revision?: { readonly round: number; readonly contextDigest: string; readonly parentCandidateIds: readonly string[] };
  /** Digest-verified generated parent files permitted by this provider's disclosure scope. */
  readonly revisionSources?: readonly { readonly candidateId: string; readonly blueprintDigest: string; readonly files: readonly { readonly path: string; readonly content: string; readonly digest: string }[] }[];
  /** Enables the runtime-owned, bounded sealed-context tool loop for raw models. */
  readonly investigationTools?: boolean;
  readonly stage: Extract<JevyrStage, "interpret" | "diverge" | "recombine" | "challenge" | "reflex">;
  readonly role: "interpreter" | "divergent" | "synthesist" | "challenger" | "reflex";
  readonly sealed: SealedCaseContext;
  readonly publicFacts: readonly PublicContribution[];
  readonly seed: string;
  readonly constraints: readonly string[];
  /** Exact candidate experiment sockets derived from the pre-Cast frontier. */
  readonly experimentCapability?: ExperimentCapability;
  /**
   * Bounded text reconstructed from the sealed private CAS. Original subject
   * locators are never present. Omission means this mind's privacy scope does
   * not permit material bytes, not that the subjects were absent from Seal.
   */
  readonly subjectProjection?: SubjectTextProjection;
  /** Read-only sealed-CAS context, separately authorized for this provider. It is never serialized to a provider. */
  readonly subjectContext?: SubjectContext;
  /** Runtime-prepared exact text; adapters must transmit this unchanged when present. */
  readonly preparedPublicPrompt?: string;
  /** Remaining sealed input-token permission across every transport attempt. */
  readonly maxInputTokens?: number;
  /** Remaining sealed completion-token permission for this invocation. */
  readonly maxOutputTokens?: number;
  readonly signal: AbortSignal;
}

/**
 * Authority-free provenance observed at an MCP caller-model sampling boundary.
 * `clientReportedModel` is deliberately named as an assertion by the caller;
 * it does not certify the provider, weights, or execution substrate behind it.
 */
export interface SamplingReceipt {
  readonly protocol: "jevyr.mcp-sampling-receipt/1";
  readonly adapterId: "mind.mcp-sampling.v1";
  readonly bindingId: string;
  readonly source: "originating-mcp-client";
  readonly clientName: string;
  readonly clientVersion: string;
  readonly mcpProtocolVersion: string;
  readonly caseDigest: string;
  readonly runDigest: string;
  readonly stage: MindRequest["stage"];
  readonly clientReportedModel: string;
  readonly stopReason: "endTurn" | null;
  readonly requestedMaxTokens: number;
  readonly promptDigest: string;
  readonly outputDigest: string;
}

export interface MindInvocationResult {
  readonly investigation?: { readonly protocol: "jevyr.model-investigation/1"; readonly providerRounds: number; readonly tools: readonly InvestigatorToolReceipt[]; readonly policyDigest: string };
  readonly contributions: readonly PublicContribution[];
  readonly tokenUsage: NurseryInvocationUsage;
  /** UTF-8 bytes in the exact prompt handed to the transport. */
  readonly transmittedInputBytes: number;
  /** UTF-8 bytes in the complete public raw output before contribution parsing. */
  readonly receivedOutputBytes: number;
  /** Present only when an MCP caller supplied this invocation's model access. */
  readonly samplingReceipt?: SamplingReceipt;
}

export interface MindAdapter {
  readonly capability: CapabilityCard;
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  run(request: MindRequest): AsyncIterable<PublicContribution>;
  /** Optional metered boundary used by sealed adaptive search. */
  runMetered?(request: MindRequest): Promise<MindInvocationResult>;
}

/** Full harness lifecycle is owned by the agent provider; its output is still testimony. */
export interface AgentAdapter extends MindAdapter { readonly adapterClass: "agent" }
/** Raw inference where Judge owns the conversation and capability-scoped tool dispatch. */
export interface ModelAdapter extends MindAdapter { readonly adapterClass: "model" }

export interface ToolInvocation {
  readonly invocationId: string;
  readonly caseId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  /** Policy-owned per-invocation remainder; tools may only tighten their sealed adapter ceiling. */
  readonly resourceLimits?: Readonly<{
    maxWritableBytes: number;
    maxWritableInodes: number;
    /** Additional persisted artifact bytes this invocation may export. */
    maxArtifactBytes: number;
  }>;
  /**
   * Bone-owned filesystem identities for a Forge cell. These paths and
   * digests are never accepted from an operator Assay Frontier. The generic
   * ToolAdapter surface keeps the field optional because observation-only
   * witnesses do not receive material roots.
   */
  readonly forgeMaterials?: ForgeInvocationMaterials | ForgeToolingInvocationMaterials;
  readonly signal: AbortSignal;
}

export interface ForgeCandidateMaterialBinding {
  /** Fresh, writable candidate source reconstructed for exactly one cell. */
  readonly sourceRoot: string;
  readonly blueprintDigest: string;
  /** Digest returned by candidate materialization before the adapter copy. */
  readonly materializationDigest: string;
  /** Canonical digest of the exact expected candidate file tree. */
  readonly treeDigest: string;
}

export interface ForgeSubjectMaterialBinding {
  /** Dedicated reconstructed subject tree, always a sibling of sourceRoot. */
  readonly subjectRoot: string;
  /** The aggregate private-CAS capture digest committed by the Case Seal. */
  readonly captureDigest: string;
  /** Digest of the synthetic subject-root layout reconstructed from the CAS. */
  readonly materializationDigest: string;
}

export interface ForgeInvocationMaterials {
  readonly protocol: "jevyr.forge-invocation-materials/1";
  readonly candidate: ForgeCandidateMaterialBinding;
  readonly subjects: ForgeSubjectMaterialBinding;
}

/** Fixed evaluator work has scratch space, but does not create a candidate. */
export interface ForgeToolingInvocationMaterials {
  readonly protocol: "jevyr.forge-invocation-materials/2";
  readonly workspace: Readonly<{ role: "empty-tooling"; sourceRoot: string }>;
  readonly subjects: ForgeSubjectMaterialBinding;
}

export interface ToolAdapter {
  readonly capability: CapabilityCard;
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  execute(invocation: ToolInvocation): Promise<ToolObservation>;
}

export interface ToolObservation {
  readonly invocationId: string;
  readonly status: "observed" | "succeeded" | "failed" | "not-executed";
  readonly summary: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** Exact stream bytes for process-backed observations; text exists only for valid UTF-8. */
  readonly stdoutCapture?: ExactByteCapture;
  readonly stderrCapture?: ExactByteCapture;
  readonly artifactRefs?: readonly string[];
  /** Machine evidence for Bone. Free-form metadata never substitutes for it. */
  readonly oracle?: ForgeOracleObservation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SealedPeerTask {
  readonly taskId: string;
  readonly sealed: SealedCaseContext;
  readonly assignment: string;
  readonly evidenceRefs: readonly string[];
  readonly signal: AbortSignal;
}

export interface PeerAdapter {
  readonly capability: CapabilityCard;
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  dispatch(task: SealedPeerTask): AsyncIterable<PublicContribution>;
}

/** Public events and records are protocol-native rather than runtime replicas. */
export type PublicTraceEvent = CaseEvent;
export type JevyrRecord = SignedRecord;
export type JevyrAxes = Pick<JevyrVerdict, "integrity" | "creation" | "embodiment" | "judgment">;
export type { DsseEnvelope };
