import { canonicalize, sha256Digest, type JsonValue } from "@jevyr/protocol";
import type { PublicContribution } from "./contracts.js";

export const PUBLIC_IDEA_PROTOCOL = "jevyr.public-idea/1" as const;
export const PUBLIC_IDEA_MEDIA_TYPE = "application/vnd.jevyr.public-idea+json" as const;

export interface PublicIdeaArtifact {
  readonly protocol: typeof PUBLIC_IDEA_PROTOCOL;
  readonly candidateId: string;
  readonly summary: string;
  readonly body?: string;
  readonly parentIds: readonly string[];
  readonly tags: readonly string[];
  readonly feasibility?: NonNullable<PublicContribution["feasibility"]>;
}

export interface EncodedPublicIdea {
  readonly value: PublicIdeaArtifact;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly size: number;
}

const REQUIRED_KEYS = Object.freeze(["candidateId", "parentIds", "protocol", "summary", "tags"]);
const OPTIONAL_KEYS = new Set(["body", "feasibility"]);

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function stringList(value: readonly string[] | undefined, label: string): readonly string[] {
  const entries = value ?? [];
  if (entries.length > 256) throw new TypeError(`${label} may contain at most 256 entries`);
  return Object.freeze(entries.map((entry, index) => {
    if (typeof entry !== "string" || entry.length > 32_768) {
      throw new TypeError(`${label}[${index}] must be a string of at most 32768 characters`);
    }
    return entry;
  }));
}

/**
 * Encodes only the model's explicitly public candidate prose and genealogy.
 * Confidence, evidence references, blueprints, and every form of hidden working
 * are deliberately outside this artifact and confer no decision authority.
 */
export function encodePublicIdea(
  candidateId: string,
  contribution: Pick<PublicContribution, "summary" | "body" | "parentIds" | "tags" | "feasibility">,
): EncodedPublicIdea {
  const normalizedCandidateId = requiredString(candidateId, "candidateId", 256);
  const summary = requiredString(contribution.summary, "summary", 32_768);
  const body = contribution.body === undefined
    ? undefined
    : (() => {
        if (typeof contribution.body !== "string") throw new TypeError("body must be a string");
        return contribution.body;
      })();
  const feasibility = contribution.feasibility;
  if (feasibility !== undefined && ![
    "BUILDABLE_NOW",
    "BRIDGEABLE",
    "LAWFUL_BUT_OPEN",
    "CONTRADICTED",
  ].includes(feasibility)) {
    throw new TypeError("feasibility is not a public Jevyr feasibility class");
  }
  const value = Object.freeze({
    protocol: PUBLIC_IDEA_PROTOCOL,
    candidateId: normalizedCandidateId,
    summary,
    ...(body === undefined ? {} : { body }),
    parentIds: stringList(contribution.parentIds, "parentIds"),
    tags: stringList(contribution.tags, "tags"),
    ...(feasibility === undefined ? {} : { feasibility }),
  }) satisfies PublicIdeaArtifact;
  const bytes = new TextEncoder().encode(canonicalize(value as unknown as JsonValue));
  return Object.freeze({
    value,
    bytes,
    digest: sha256Digest(bytes),
    size: bytes.byteLength,
  });
}

/** Accepts only the exact canonical public-idea representation emitted above. */
export function decodePublicIdea(bytes: Uint8Array): PublicIdeaArtifact {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Public-idea artifact is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("Public-idea artifact is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Public-idea artifact must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (REQUIRED_KEYS.some((key) => !Object.hasOwn(record, key))
    || keys.some((key) => !REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.has(key))) {
    throw new TypeError("Public-idea artifact fields are not closed");
  }
  if (record.protocol !== PUBLIC_IDEA_PROTOCOL
    || typeof record.candidateId !== "string"
    || typeof record.summary !== "string"
    || !Array.isArray(record.parentIds)
    || !Array.isArray(record.tags)
    || (record.body !== undefined && typeof record.body !== "string")) {
    throw new TypeError("Public-idea artifact shape is invalid");
  }
  const feasibility = record.feasibility as NonNullable<PublicContribution["feasibility"]> | undefined;
  const encoded = encodePublicIdea(record.candidateId, {
    summary: record.summary,
    ...(record.body === undefined ? {} : { body: record.body }),
    parentIds: record.parentIds as string[],
    tags: record.tags as string[],
    ...(feasibility === undefined ? {} : { feasibility }),
  });
  if (new TextDecoder().decode(encoded.bytes) !== text) {
    throw new TypeError("Public-idea artifact is not canonical Jevyr JSON");
  }
  return encoded.value;
}
