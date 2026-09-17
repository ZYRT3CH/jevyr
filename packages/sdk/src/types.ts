import type {
  CASE_PROTOCOL,
  CaseEvent,
  CaseIntent,
  CaseSubmission as ProtocolCaseSubmission,
  DsseEnvelope,
  IntentContract,
  JsonValue,
  JevyrVerdict,
  LiveCaseStatus,
  LiveEventBatch,
  PublicTrustBundle,
  SealedCase,
  SealReceipt,
  SessionControl,
  SignedRecord,
  SubjectReference,
  TerminalReceipt,
} from "@jevyr/protocol";

export type Control = SessionControl;
export type Privacy = NonNullable<CaseIntent["privacy"]>;
export type { CaseEvent, CaseIntent, ProtocolCaseSubmission, DsseEnvelope, IntentContract, LiveCaseStatus, LiveEventBatch, PublicTrustBundle, SealedCase, SealReceipt, SignedRecord, SubjectReference, TerminalReceipt };

/** Cast input may omit the fixed protocol discriminator as an SDK convenience. */
export interface CastSubmission {
  readonly protocol?: typeof CASE_PROTOCOL;
  readonly case: CaseIntent;
}

/** The daemon returns the canonical receipt itself from POST /v1/cases. */
export type CastAccepted = SealReceipt;
export type CaseStatus = LiveCaseStatus;
export type PublicTraceEvent = CaseEvent;
export type EventPage = LiveEventBatch;
export type JevyrRecord = SignedRecord;
export type JevyrAxes = Pick<JevyrVerdict, "integrity" | "creation" | "embodiment" | "judgment">;

export type ReadinessProbeStatus = "available" | "unavailable" | "failed" | "timed-out" | "invalid";
export type ReadinessBlockerCode =
  | "models.template-only"
  | "models.reasoning-unavailable"
  | "forge.observe-only"
  | "forge.diagnostic-only"
  | "forge.opaque"
  | "forge.substrate-unavailable"
  | "forge.execution-disabled"
  | "forge.probe-unavailable"
  | "assays.empty";

export interface ReadinessProbe {
  readonly status: ReadinessProbeStatus;
  readonly observedAt: string;
  readonly latencyMs: number;
}

export interface GenomeLab {
  readonly protocol: "jevyr.genome-lab/1";
  readonly selfJudgmentRequests?: readonly {
    readonly protocol: "jevyr.self-judge-offspring-request/1";
    readonly digest: string;
    readonly source: { readonly caseId: string; readonly runDigest: string; readonly recordDigest: string | null; readonly manifestDigest: string; readonly genomeDigest: string };
    readonly failures: readonly { readonly code: string; readonly evidenceDigest: string }[];
    readonly candidateGenomeDigest: string; readonly parentGenomeDigest: string | null; readonly growthProposalDigest: string | null;
    readonly decision: "REJECTED_PENDING_BENCHMARKS" | "REQUESTED_NO_GOVERNED_PARENT";
    readonly proposedChange: string;
    readonly benchmarkEvidence: readonly []; readonly damageEvidence: readonly []; readonly governanceSignature: null; readonly activeGenomeChanged: false;
  }[];
  readonly preset?: { readonly mode: "preset" | "wild"; readonly selectionDigest: string; readonly descriptor: JsonValue; readonly applies: "next-runtime-startup" };
  readonly active: { readonly version: string; readonly digest: string; readonly source: "baseline" | "governance-promotion" | "benchmark-experiment"; readonly selectionDigest: string; readonly descriptor: JsonValue };
  readonly governance: { readonly startupBound: true; readonly requiresBenchmarkEvidence: true; readonly requiresGovernanceSignature: true; readonly semanticPromotion: false };
  readonly offspring: readonly {
    readonly proposalDigest: string; readonly parentDigest: string; readonly genomeDigest: string;
    readonly decision: string; readonly reasons: readonly string[];
    readonly benchmarkEvidence: readonly { readonly suite: string; readonly heldOut: boolean; readonly invariant: boolean; readonly passed: boolean; readonly score: number; readonly parentScore: number; readonly evidenceDigest: string }[];
    readonly damageEvidence: readonly { readonly id: string; readonly kind: string; readonly passed: boolean; readonly recoveredToBone: boolean; readonly evidenceDigest: string }[];
  }[];
  readonly truncated: boolean;
}

/** Sanitized, read-only infrastructure availability. This is never a Case verdict. */
export interface JevyrReadiness {
  readonly protocol: "jevyr.readiness/1";
  readonly ready: boolean;
  readonly scope: "infrastructure";
  readonly observedAt: string;
  readonly semanticContinuation: false;
  readonly models: {
    readonly status: "ready" | "template-only" | "unavailable";
    readonly mode: "template-only" | "local" | "remote" | "mixed" | "configured-unavailable";
    readonly configuredCount: number;
    readonly availableCount: number;
    readonly reasoningConfiguredCount: number;
    readonly reasoningAvailableCount: number;
    readonly adapters: readonly {
      readonly id: string;
      readonly role: "template" | "reasoning";
      readonly configured: true;
      readonly transport: "process" | "http" | "in-process" | "a2a";
      readonly network: "none" | "loopback" | "provider" | "unrestricted";
      readonly probe: ReadinessProbe;
    }[];
  };
  readonly forge: {
    readonly id: string;
    readonly mode: "docker" | "trusted-host" | "observe-only" | "opaque";
    readonly configured: true;
    readonly status: "ready" | "substrate-unavailable" | "execution-disabled" | "probe-unavailable" | "observe-only" | "diagnostic-only" | "opaque";
    readonly canExecuteTools: boolean;
    readonly network: "none" | "loopback" | "provider" | "unrestricted";
    readonly probe: ReadinessProbe;
    readonly evidenceAuthority: "verified-docker" | "diagnostic-only" | "none";
    readonly substrate: {
      readonly status: "resolved" | "unavailable" | "not-applicable" | "opaque";
      readonly immutableImageId: string | null;
    };
    readonly usable: boolean;
  };
  readonly assays: {
    readonly status: "admitted" | "empty";
    readonly mode: "empty" | "comparative-only" | "case-binding-configured" | "mixed";
    readonly count: number;
    readonly ids: readonly string[];
    readonly frontierDigest: string;
    readonly caseApplicability: "case-dependent";
  };
  readonly blockers: readonly {
    readonly code: ReadinessBlockerCode;
    readonly component: "models" | "forge" | "assays";
    readonly detail: string;
  }[];
}

/** Content-addressed artifact metadata returned by the Case artifact index. */
export interface ArtifactMeta {
  readonly protocol: "jevyr.artifact/1";
  readonly id: string;
  readonly caseId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly digest: string;
  readonly createdAt: string;
}

/** Canonical response envelope for a Case artifact index. */
export interface ArtifactList {
  readonly protocol: "jevyr.artifacts/1";
  readonly caseId: string;
  readonly artifacts: readonly ArtifactMeta[];
}

/** Artifact bytes accepted only after metadata, headers, length, and hash agree. */
export interface VerifiedArtifact {
  readonly meta: ArtifactMeta;
  readonly data: Uint8Array;
  readonly verification: "sha256";
}

/** Content-addressed provenance descriptor stored independently of any Case. */
export interface DescriptorArtifact {
  readonly protocol: "jevyr.descriptor-artifact/1";
  readonly kind: "policy" | "genome" | "search";
  readonly digest: string;
  readonly descriptor: JsonValue;
}

/** The exact policy descriptor selected by one sealed Case and run. */
export interface CasePolicyDescriptor {
  readonly protocol: "jevyr.case-policy-descriptor/1";
  readonly caseId: string;
  readonly caseDigest: string;
  readonly runDigest: string;
  readonly policyDigest: string;
  readonly artifact: DescriptorArtifact & { readonly kind: "policy" };
}

/** Policy bytes whose digest is linked to an Ed25519-authenticated Record. */
export interface VerifiedCasePolicyDescriptor {
  readonly binding: CasePolicyDescriptor;
  readonly record: AuthenticatedRecord;
  readonly verification: "sha256+dsse-record-binding";
}

export interface LiveFrame {
  readonly event: CaseEvent;
  readonly cursor: number;
  /** Canonical digest of the latest verified event. */
  readonly headDigest: string;
  /** @deprecated Use headDigest. Kept as a source-compatible alias. */
  readonly segmentDigest: string;
  /** Verification is limited to public event shape, identity, digest, and prior-link continuity. */
  readonly verificationScope: "event-hash-chain";
  readonly continuity: "verified";
  readonly transport: "sse" | "poll";
}

export interface LiveOptions {
  /** Zero means before the first event; public event sequences start at one. */
  readonly cursor?: number;
  /** Digest at cursor. Supplying it avoids one anchor request when cursor is non-zero. */
  readonly cursorDigest?: string;
  readonly signal?: AbortSignal;
  readonly preferSse?: boolean;
  readonly pollWaitMs?: number;
  /** Initial delay after a transport failure; retries back off exponentially. */
  readonly reconnectDelayMs?: number;
  /** Upper bound for transport retry backoff. */
  readonly maxReconnectDelayMs?: number;
  readonly maxSseFailures?: number;
}

export interface JevyrClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Payload authenticated by a trusted Ed25519 key over the DSSE PAE bytes. */
export interface VerifiedDssePayload<T> {
  readonly payload: T;
  readonly envelope: DsseEnvelope;
  readonly keyId: string;
  readonly payloadType: string;
  readonly verification: "dsse-ed25519";
}

/**
 * A signed Record whose canonical bytes and Seal-linked provenance authenticate.
 * Persisted evidence is deliberately not claimed without independent replay.
 */
export interface AuthenticatedRecord extends VerifiedDssePayload<JevyrRecord> {
  readonly verificationScope: "dsse-signature+seal-provenance";
  readonly persistedEvidence: "not-replayed";
}

/** A terminal closure payload authenticated independently from its endpoint bytes. */
export type AuthenticatedTerminalReceipt = VerifiedDssePayload<TerminalReceipt>;

/** Authenticated Record bound to the signed terminal trace, status, and artifact inventory. */
export interface AuthenticatedTerminalRecord extends AuthenticatedRecord {
  readonly terminal: AuthenticatedTerminalReceipt;
  readonly traceVerification: "event-hash-chain+signed-terminal-head";
}

export interface EventChainVerification {
  readonly valid: boolean;
  readonly headDigest: string | null;
  readonly caseDigest?: string;
  readonly runDigest?: string;
  readonly problems: readonly string[];
}
