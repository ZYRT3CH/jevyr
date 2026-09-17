import { digestJson, type JsonValue } from "./canonical.js";
import {
  SEARCH_ENVELOPE_PROTOCOL,
  type SealedSearchProfile,
  type SearchEnvelope,
} from "./types.js";
import { assertSearchEnvelope } from "./validation.js";

/** Canonical payload addressed by `SearchEnvelope.digest`. */
export function searchEnvelopeDescriptor(envelope: Pick<SearchEnvelope, "protocol" | "profile">): JsonValue {
  return {
    protocol: envelope.protocol,
    profile: structuredClone(envelope.profile) as unknown as JsonValue,
  };
}

export function searchEnvelopeDigest(envelope: Pick<SearchEnvelope, "protocol" | "profile">): string {
  return digestJson(searchEnvelopeDescriptor(envelope));
}

/** Constructs and validates the immutable pre-Cast search/resource envelope. */
export function createSearchEnvelope(profile: SealedSearchProfile): SearchEnvelope {
  const basis = {
    protocol: SEARCH_ENVELOPE_PROTOCOL,
    profile: structuredClone(profile),
  } as const;
  const envelope: SearchEnvelope = Object.freeze({
    ...basis,
    profile: Object.freeze({
      ...basis.profile,
      nursery: Object.freeze({ ...basis.profile.nursery }),
      resources: Object.freeze({ ...basis.profile.resources }),
    }),
    digest: searchEnvelopeDigest(basis),
  });
  assertSearchEnvelope(envelope);
  return envelope;
}

export function verifySearchEnvelope(envelope: unknown): envelope is SearchEnvelope {
  try {
    assertSearchEnvelope(envelope);
    return true;
  } catch {
    return false;
  }
}
