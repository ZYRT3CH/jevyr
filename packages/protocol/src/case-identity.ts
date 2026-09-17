import { digestJson, type JsonValue } from "./canonical.js";
import {
  CASE_PROTOCOL,
  type NormalizedCaseIntent,
  type SubjectSnapshot,
} from "./types.js";

function stableSubjectSnapshot(snapshot: SubjectSnapshot): JsonValue {
  return {
    subjectId: snapshot.subjectId,
    digest: snapshot.digest,
    resolvedLocator: snapshot.resolvedLocator,
    ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
    ...(snapshot.byteLength === undefined ? {} : { byteLength: snapshot.byteLength }),
    ...(snapshot.mediaType === undefined ? {} : { mediaType: snapshot.mediaType }),
  } as JsonValue;
}

/**
 * Canonical identity for a Case across repeated executions. Capture time is
 * deliberately excluded, while the exact private-material binding digest is
 * included. Equal bytes/declarations retain one Case identity; any binding or
 * manifest change creates another identity.
 */
export function sealedCaseIdentityDescriptor(input: {
  readonly intent: NormalizedCaseIntent;
  readonly intentContractDigest: string;
  readonly subjectMaterialCaptureDigest: string;
  readonly subjects: readonly SubjectSnapshot[];
}): JsonValue {
  return {
    protocol: CASE_PROTOCOL,
    intent: input.intent as unknown as JsonValue,
    intentContractDigest: input.intentContractDigest,
    subjectMaterialCaptureDigest: input.subjectMaterialCaptureDigest,
    subjects: [...input.subjects]
      .sort((left, right) => left.subjectId.localeCompare(right.subjectId))
      .map(stableSubjectSnapshot),
  };
}

export function sealedCaseIdentityDigest(input: Parameters<typeof sealedCaseIdentityDescriptor>[0]): string {
  return digestJson(sealedCaseIdentityDescriptor(input));
}
