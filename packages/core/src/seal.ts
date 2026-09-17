import {
  CASE_PROTOCOL,
  assertCaseSubmission,
  assertSearchEnvelope,
  digestJson,
  isSha256Digest,
  sealedCaseIdentityDigest,
  type CaseSubmission,
  type JsonValue,
  type NormalizedCaseIntent,
  type SealReceipt,
  type SearchEnvelope,
  type SealedCase,
  type SubjectReference,
  type SubjectSnapshot,
} from "@jevyr/protocol";
import { compileIntentContract } from "./intent.js";

export interface SealOptions {
  policyVersion: string;
  policyDigest: string;
  genomeVersion: string;
  genomeDigest: string;
  searchEnvelope: SearchEnvelope;
  sealedAt: string;
  /** Exact digest returned by captureSubjectMaterials for this Case. */
  subjectMaterialCaptureDigest: string;
  subjectSnapshots?: readonly SubjectSnapshot[];
}

function uniqueSorted(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map((item) => item.trim()).filter(Boolean))].sort();
}

function normalizedSubjects(subjects: readonly SubjectReference[] | undefined): readonly SubjectReference[] {
  return [...(subjects ?? [])]
    .map((subject) => ({
      id: subject.id.trim(),
      kind: subject.kind,
      locator: subject.locator.trim(),
      ...(subject.revision === undefined ? {} : { revision: subject.revision }),
      ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function assertSnapshots(subjects: readonly SubjectReference[], snapshots: readonly SubjectSnapshot[]): void {
  const expected = new Set(subjects.map((subject) => subject.id));
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    if (!expected.has(snapshot.subjectId)) throw new TypeError(`Snapshot refers to unknown subject ${snapshot.subjectId}`);
    if (seen.has(snapshot.subjectId)) throw new TypeError(`Duplicate snapshot for subject ${snapshot.subjectId}`);
    if (!isSha256Digest(snapshot.digest)) throw new TypeError(`Snapshot ${snapshot.subjectId} lacks a SHA-256 digest`);
    if (Number.isNaN(Date.parse(snapshot.capturedAt))) throw new TypeError(`Snapshot ${snapshot.subjectId} has an invalid capturedAt time`);
    seen.add(snapshot.subjectId);
  }
  for (const subjectId of expected) {
    if (!seen.has(subjectId)) throw new TypeError(`Subject ${subjectId} was not snapshotted before seal`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function sealCase(submission: CaseSubmission, options: SealOptions): SealedCase {
  assertCaseSubmission(submission);
  if (!options.policyVersion.trim() || !options.genomeVersion.trim()) throw new TypeError("policyVersion and genomeVersion are required");
  if (!isSha256Digest(options.policyDigest)) throw new TypeError("policyDigest must be a SHA-256 digest");
  if (!isSha256Digest(options.genomeDigest)) throw new TypeError("genomeDigest must be a SHA-256 digest");
  if (!isSha256Digest(options.subjectMaterialCaptureDigest)) {
    throw new TypeError("subjectMaterialCaptureDigest must be a SHA-256 digest");
  }
  assertSearchEnvelope(options.searchEnvelope);
  if (Number.isNaN(Date.parse(options.sealedAt))) throw new TypeError("sealedAt must be an ISO timestamp");

  const submissionDigest = digestJson(submission as unknown as JsonValue);
  const subjects = normalizedSubjects(submission.case.subjects);
  const snapshots = [...(options.subjectSnapshots ?? [])].sort((a, b) => a.subjectId.localeCompare(b.subjectId));
  assertSnapshots(subjects, snapshots);

  const intent: NormalizedCaseIntent = {
    impulse: submission.case.impulse.trim(),
    mode: submission.case.mode ?? "auto",
    subjects,
    constraints: uniqueSorted(submission.case.constraints),
    requestedAssays: uniqueSorted(submission.case.requestedAssays),
    privacy: submission.case.privacy ?? "local_only",
    control: submission.case.control ?? "sovereign",
    seed: submission.case.seed?.trim() || submissionDigest.slice("sha256:".length),
  };
  const intentContract = compileIntentContract({
    impulse: submission.case.impulse,
    constraints: intent.constraints,
    requestedAssays: intent.requestedAssays,
    subjectIds: intent.subjects.map((subject) => subject.id),
  });

  const caseDigest = sealedCaseIdentityDigest({
    intent,
    intentContractDigest: intentContract.digest,
    subjectMaterialCaptureDigest: options.subjectMaterialCaptureDigest,
    subjects: snapshots,
  });
  const runDigest = digestJson({
    caseDigest,
    policyVersion: options.policyVersion,
    policyDigest: options.policyDigest,
    genomeVersion: options.genomeVersion,
    genomeDigest: options.genomeDigest,
    searchDigest: options.searchEnvelope.digest,
    seed: intent.seed,
    sealedAt: options.sealedAt,
  });
  const sealed: SealedCase = {
    protocol: CASE_PROTOCOL,
    caseId: `case_${runDigest.slice(7, 23)}`,
    submissionDigest,
    subjectMaterialCaptureDigest: options.subjectMaterialCaptureDigest,
    caseDigest,
    runDigest,
    sealedAt: options.sealedAt,
    policyVersion: options.policyVersion,
    policyDigest: options.policyDigest,
    genomeVersion: options.genomeVersion,
    genomeDigest: options.genomeDigest,
    searchEnvelope: structuredClone(options.searchEnvelope),
    intentContractDigest: intentContract.digest,
    intentContract,
    intent,
    subjects: snapshots,
  };
  return deepFreeze(structuredClone(sealed));
}

export function sealReceipt(sealed: SealedCase): SealReceipt {
  return {
    protocol: "jevyr.seal/1",
    caseId: sealed.caseId,
    submissionDigest: sealed.submissionDigest,
    subjectMaterialCaptureDigest: sealed.subjectMaterialCaptureDigest,
    caseDigest: sealed.caseDigest,
    runDigest: sealed.runDigest,
    sealedAt: sealed.sealedAt,
    policyVersion: sealed.policyVersion,
    policyDigest: sealed.policyDigest,
    genomeVersion: sealed.genomeVersion,
    genomeDigest: sealed.genomeDigest,
    searchDigest: sealed.searchEnvelope.digest,
    intentContractDigest: sealed.intentContractDigest,
  };
}
