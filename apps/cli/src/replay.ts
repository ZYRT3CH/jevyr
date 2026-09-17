import { readFile } from "node:fs/promises";
import { parseJsonBytes, replayCase, formalProofKernelDigestFromPolicyDescriptor } from "@jevyr/core";
import {
  verifyPersistedAssayEvidence,
  TOOL_OBSERVATION_MEDIA_TYPE,
  PUBLIC_IDEA_MEDIA_TYPE,
  REPOSITORY_OBSERVER_ARTIFACT_MEDIA,
  ORIGINAL_SUBJECT_CERTIFICATE_MEDIA,
  MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES,
  type AssayEvidenceArtifactResolver,
  type AssayFrontier,
  type PersistedAssayEvidenceReplayReport,
  type OriginalSubjectCertificateContext,
} from "@jevyr/runtime";
import {
  assertIntentContractPayload,
  assertCasePolicyDescriptor,
  assertPolicyDescriptorRecordBinding,
  assertRecordPayload,
  canonicalJson,
  type JevyrClient,
  verifyEventChain,
  type CasePolicyDescriptor,
  type IntentContract,
  type JevyrRecord,
  type PublicTraceEvent,
} from "@jevyr/sdk";

const REPLAYABLE_ARTIFACT_MEDIA_TYPES = new Set([
  TOOL_OBSERVATION_MEDIA_TYPE,
  PUBLIC_IDEA_MEDIA_TYPE,
  ...Object.values(REPOSITORY_OBSERVER_ARTIFACT_MEDIA),
  ORIGINAL_SUBJECT_CERTIFICATE_MEDIA,
  "application/vnd.jevyr.candidate-population+json",
  "application/vnd.jevyr.candidate-blueprint+json",
  "application/vnd.jevyr.metabolism-redemption+json",
  "application/vnd.jevyr.evidence-scheduling+json",
  "application/vnd.jevyr.critical-challenge+json",
  "application/vnd.jevyr.phenotype+json",
  "application/vnd.jevyr.reproduction-memory+json",
  "application/vnd.jevyr.execution-feedback+json",
  "application/vnd.jevyr.revision-population+json",
  "application/vnd.jevyr.inertia-continuation+json",
  "application/vnd.jevyr.metabolic-checkpoint+json",
  "application/vnd.jevyr.metabolic-reproduction+json",
]);

export interface ReplayResult {
  readonly valid: boolean;
  readonly expected: string;
  readonly observed: string | null;
  readonly terminalHead: string | null;
  readonly events: number;
  readonly problems: readonly string[];
  readonly evidenceReplay?: PersistedAssayEvidenceReplayReport;
}

export interface ReplayTraceOptions {
  readonly persistedEvidence?: Readonly<{
    readonly policyDescriptor: CasePolicyDescriptor;
    readonly resolveArtifact: AssayEvidenceArtifactResolver;
    readonly trustedRecordKeys?: ReadonlyMap<string, string>;
    readonly originalSubject?: OriginalSubjectCertificateContext;
  }>;
}

/** Reads one complete public ledger. Full-chain verification still happens in replayTrace. */
export async function allEvents(
  client: JevyrClient,
  caseId: string,
): Promise<PublicTraceEvent[]> {
  const events: PublicTraceEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await client.pollEvents(caseId, cursor, { limit: 2_000 });
    events.push(...page.events);
    if (page.caughtUp) return events;
    if (page.throughSequence === cursor) {
      throw new Error("Event pagination made no progress before reaching the ledger head");
    }
    cursor = page.throughSequence;
  }
}

function jsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function originalSubjectActivity(events: readonly PublicTraceEvent[]): boolean {
  return events.some(event => event.kind === "action.status" && event.payload.actionType === "repository-pure.evaluate"
    || event.kind === "evidence.observed" && event.payload.evidenceType === "original_subject_assertions");
}

/** Extracts only the Frontier whose digest is committed by the effective policy. */
export function assayFrontierFromPolicyDescriptor(
  binding: CasePolicyDescriptor,
): AssayFrontier {
  const outer = binding.artifact.descriptor;
  if (!jsonRecord(outer) || outer.protocol !== "jevyr.policy-descriptor/1" || !jsonRecord(outer.policy)) {
    throw new TypeError("Authenticated policy descriptor has no canonical policy payload");
  }
  const effective = outer.policy;
  const frontier = effective.assayFrontier;
  if (
    effective.protocol !== "jevyr.effective-policy/1"
    || typeof effective.assayFrontierDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(effective.assayFrontierDigest)
    || !jsonRecord(frontier)
    || frontier.digest !== effective.assayFrontierDigest
  ) {
    throw new TypeError("Authenticated policy descriptor does not bind one exact Assay Frontier");
  }
  return frontier as unknown as AssayFrontier;
}

export async function replayTrace(
  record: JevyrRecord,
  events: readonly PublicTraceEvent[],
  intentContract: IntentContract,
  options: ReplayTraceOptions = {},
): Promise<ReplayResult> {
  const contract = assertIntentContractPayload(intentContract);
  const chain = await verifyEventChain(events);
  const problems = [...chain.problems];
  if (chain.caseDigest !== record.caseDigest)
    problems.push("Record caseDigest does not match the event ledger");
  if (chain.runDigest !== record.runDigest)
    problems.push("Record runDigest does not match the event ledger");
  if (contract.digest !== record.intentContractDigest)
    problems.push("IntentContract digest does not match the Record");
  const anchor = events.findIndex((event) => event.eventDigest === record.eventHeadDigest);
  if (anchor < 0) {
    problems.push(
      "Record eventHeadDigest is not a verified crystallization prefix of the event ledger",
    );
  }
  const replayEvents = anchor < 0 ? events : events.slice(0, anchor + 1);
  const formalProofKernelDigest = options.persistedEvidence === undefined ? undefined : formalProofKernelDigestFromPolicyDescriptor(options.persistedEvidence.policyDescriptor.artifact.descriptor);
  if (replayEvents.some((event) => event.kind === "evidence.observed" && event.payload.formalProof !== undefined) && formalProofKernelDigest === undefined) {
    problems.push("Formal proof checker identity is unsupported by this verifier: use the exact sealed runtime build and import condition (compiled JavaScript and development TypeScript have distinct checker digests).");
  }
  const sandboxExecutionCount = replayEvents.filter((event) =>
    event.kind === "evidence.observed" && event.payload.evidenceType === "sandbox_execution"
  ).length;
  const hasAssayReplayActivity = record.verdict.policyVersion === "jevyr.bone/2" || sandboxExecutionCount > 0 || originalSubjectActivity(replayEvents) || replayEvents.some((event) =>
    (event.kind === "action.status" && ["candidate.population.close", "repository-evaluation.observe"].includes(event.payload.actionType))
    || (event.kind === "evidence.observed" && event.stage === "assay"
      && event.payload.candidateId !== undefined && event.payload.assayId !== undefined)
  );
  let evidenceReplay: PersistedAssayEvidenceReplayReport | undefined;
  if (hasAssayReplayActivity && options.persistedEvidence === undefined) {
    problems.push(
      `The replay prefix contains a persisted Assay Frontier transcript (${sandboxExecutionCount} sandbox execution${sandboxExecutionCount === 1 ? "" : "s"}), but no exact policy descriptor and artifact resolver were supplied`,
    );
  } else if (options.persistedEvidence !== undefined) {
    try {
      const policyDescriptor = await assertCasePolicyDescriptor(
        options.persistedEvidence.policyDescriptor,
        options.persistedEvidence.policyDescriptor.caseId,
      );
      assertPolicyDescriptorRecordBinding(policyDescriptor, record);
      const assayFrontier = assayFrontierFromPolicyDescriptor(policyDescriptor);
      evidenceReplay = await verifyPersistedAssayEvidence(
        replayEvents,
        contract,
        assayFrontier,
        policyDescriptor.artifact.descriptor,
        options.persistedEvidence.resolveArtifact,
        {
          ...(options.persistedEvidence.trustedRecordKeys === undefined ? {} : { trustedRecordKeys: options.persistedEvidence.trustedRecordKeys }),
          ...(options.persistedEvidence.originalSubject === undefined ? {} : { originalSubject: options.persistedEvidence.originalSubject }),
        },
      );
      if (!evidenceReplay.replayComplete) {
        for (const entry of evidenceReplay.problems) {
          problems.push(`Persisted evidence ${entry.code} at event ${entry.sequence}: ${entry.message}`);
        }
      }
    } catch (error) {
      problems.push(
        `Persisted sandbox evidence could not be independently replayed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (anchor >= 0 && chain.valid && contract.digest === record.intentContractDigest) {
    const replay = replayCase(replayEvents, {
      policyVersion: record.verdict.policyVersion,
      intentContract: contract,
      verifiedEvidenceEdges: evidenceReplay?.verifiedAuthorityEdges ?? [],
      verifiedOriginalSubjectEdges: evidenceReplay?.verifiedOriginalSubjectEdges ?? [],
      ...(evidenceReplay?.originalSubjectContext === undefined ? {} : { originalSubjectContext: evidenceReplay.originalSubjectContext }),
      ...(formalProofKernelDigest === undefined ? {} : { formalProofKernelDigest }),
    });
    if (!replay.crystallizable)
      problems.push("The recorded prefix does not contain a complete valid Reflex");
    if (canonicalJson(replay.verdict) !== canonicalJson(record.verdict))
      problems.push("Deterministic policy replay produced a different verdict");
  }
  return {
    valid: problems.length === 0,
    expected: record.eventHeadDigest,
    observed: anchor < 0 ? null : (events[anchor]?.eventDigest ?? null),
    terminalHead: chain.headDigest,
    events: events.length,
    problems,
    ...(evidenceReplay === undefined ? {} : { evidenceReplay }),
  };
}

/**
 * Independently replays a remotely authenticated Case, including persisted
 * evidence artifacts, and binds the reconstructed ledger to terminal status.
 */
export async function replayAuthenticatedCase(
  client: JevyrClient,
  caseId: string,
  record: JevyrRecord,
): Promise<ReplayResult> {
  const [verifiedPolicy, intentContract, events, trust] = await Promise.all([
    client.verifiedPolicyDescriptor(caseId),
    client.verifiedIntentContract(caseId),
    allEvents(client, caseId),
    client.trustBundle(),
  ]);
  const trustedKeys = new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem]));
  // V2 derives judgment target from authenticated intent even when a malicious
  // or incomplete transcript omitted every original-subject evaluation action.
  const descriptorVersion = (verifiedPolicy.binding.artifact.descriptor as { readonly version?: unknown } | null)?.version;
  const needsOriginalContext = record.verdict.policyVersion === "jevyr.bone/2"
    || verifiedPolicy.record?.payload.verdict.policyVersion === "jevyr.bone/2"
    || descriptorVersion === "jevyr.bone/2" || originalSubjectActivity(events);
  const originalSubject = needsOriginalContext ? await (async (): Promise<OriginalSubjectCertificateContext> => {
    const [sealedCase, sealEnvelope] = await Promise.all([client.verifiedSealedCase(caseId), client.sealEnvelope(caseId)]);
    return { sealedCase, sealEnvelope, trustedCaseKeys: trustedKeys };
  })() : undefined;
  const artifactIndex = new Map((await client.listArtifacts(caseId)).map(meta => [meta.digest, meta]));
  const replay = await replayTrace(record, events, intentContract, {
    persistedEvidence: {
      policyDescriptor: verifiedPolicy.binding,
      trustedRecordKeys: trustedKeys,
      ...(originalSubject === undefined ? {} : { originalSubject }),
      resolveArtifact: async (digest) => {
        const metadata = artifactIndex.get(digest);
        if (metadata === undefined) return undefined;
        if (!REPLAYABLE_ARTIFACT_MEDIA_TYPES.has(metadata.mediaType)) throw new TypeError(`Replay digest ${digest} resolves to unsupported media type ${metadata.mediaType}`);
        if (metadata.mediaType === ORIGINAL_SUBJECT_CERTIFICATE_MEDIA && metadata.size > MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES) {
          throw new RangeError("Original-subject certificate exceeds its bounded replay envelope");
        }
        const artifact = await client.artifactByDigest(caseId, digest);
        if (artifact === undefined) return undefined;
        if (metadata === undefined || canonicalJson(artifact.meta) !== canonicalJson(metadata)) throw new TypeError("Replay artifact metadata changed during retrieval");
        if (!REPLAYABLE_ARTIFACT_MEDIA_TYPES.has(artifact.meta.mediaType)) {
          throw new TypeError(
            `Replay digest ${digest} resolves to unsupported media type ${artifact.meta.mediaType}`,
          );
        }
        return artifact.data;
      },
    },
  });

  const status = await client.status(caseId);
  const problems = [...replay.problems];
  const finalEvent = events.at(-1);
  const observedSequence = finalEvent?.sequence ?? 0;
  const observedHead = finalEvent?.eventDigest ?? null;
  if (status.lifecycle !== "terminated" && status.lifecycle !== "invalid") {
    problems.push(`Remote Case is not terminal (lifecycle ${status.lifecycle})`);
  }
  if (status.caseDigest !== record.caseDigest || status.runDigest !== record.runDigest) {
    problems.push("Terminal status does not belong to the authenticated Record's case and run");
  }
  if (status.lastSequence !== observedSequence || status.headDigest !== observedHead) {
    problems.push("Reconstructed ledger does not end at the terminal status head");
  }
  return { ...replay, valid: problems.length === 0, problems };
}

export async function readRecord(path: string): Promise<JevyrRecord> {
  return assertRecordPayload(parseJsonBytes(await readFile(path), "Local Record"));
}

export async function readIntentContract(path: string): Promise<IntentContract> {
  return assertIntentContractPayload(parseJsonBytes(await readFile(path), "Local IntentContract"));
}

/** Bare files can be structurally replayed only when the caller explicitly waives authenticity verification. */
export async function readUnsignedDiagnosticRecord(
  path: string,
  enabled: boolean,
): Promise<JevyrRecord> {
  if (!enabled) {
    throw new TypeError(
      "Bare local record.json has no verifiable signature context; add --unsigned-diagnostic to inspect it without authenticity claims",
    );
  }
  return await readRecord(path);
}

export interface RecordDifference {
  readonly field: string;
  readonly left: unknown;
  readonly right: unknown;
}

export function compareRecords(left: JevyrRecord, right: JevyrRecord): RecordDifference[] {
  const differences: RecordDifference[] = [];
  for (const field of ["integrity", "creation", "embodiment", "judgment"] as const) {
    if (left.verdict[field] !== right.verdict[field])
      differences.push({
        field: `verdict.${field}`,
        left: left.verdict[field],
        right: right.verdict[field],
      });
  }
  for (const field of [
    "caseDigest",
    "runDigest",
    "policyDigest",
    "genomeDigest",
    "searchDigest",
    "intentContractDigest",
    "eventHeadDigest",
  ] as const) {
    if (left[field] !== right[field])
      differences.push({ field, left: left[field], right: right[field] });
  }
  if (left.verdict.policyVersion !== right.verdict.policyVersion)
    differences.push({
      field: "verdict.policyVersion",
      left: left.verdict.policyVersion,
      right: right.verdict.policyVersion,
    });
  if (left.verdict.selectedCandidateId !== right.verdict.selectedCandidateId)
    differences.push({
      field: "verdict.selectedCandidateId",
      left: left.verdict.selectedCandidateId,
      right: right.verdict.selectedCandidateId,
    });
  return differences;
}
