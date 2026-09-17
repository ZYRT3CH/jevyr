import {
  CASE_PROTOCOL,
  EVENT_PROTOCOL,
  INTENT_COMPILER_VERSION,
  INTENT_CONTRACT_PROTOCOL,
  LIFECYCLE_STAGES,
  RECORD_PROTOCOL,
  SEARCH_ENVELOPE_PROTOCOL,
  TERMINAL_PROTOCOL,
  type CaseEvent,
  type CaseSubmission,
  type EventKind,
  type IntentContract,
  type NormalizedCaseIntent,
  type ProtocolProblem,
  type SealReceipt,
  type SearchEnvelope,
  type SealedCase,
  type SignedRecord,
  type SubjectReference,
  type SubjectSnapshot,
  type TerminalReceipt,
  type ValidationResult,
} from "./types.js";
import { digestJson, isSha256Digest, sha256Digest, type JsonValue } from "./canonical.js";
import { sealedCaseIdentityDigest } from "./case-identity.js";
import compiledSubmissionSchema from "./generated-case-validator.js";
const validateSubmissionSchema = compiledSubmissionSchema as ((value: unknown) => boolean) & { errors?: readonly { instancePath: string; message?: string }[] | null };

const MODES = new Set(["auto", "audit", "design"]);
const PRIVACY = new Set(["full_case", "provider_scoped", "local_only"]);
const CONTROL = new Set(["sovereign", "juggler"]);
const SUBJECT_KINDS = new Set(["git", "directory", "file", "url", "text", "artifact"]);
const ACTOR_KINDS = new Set(["kernel", "mind", "tool", "peer", "forge", "archivist"]);
const EVENT_KINDS = new Set<EventKind>([
  "stage.status",
  "claim.published",
  "action.status",
  "evidence.observed",
  "candidate.status",
  "assay.status",
  "reflex.completed",
  "memory.influence",
  "search.status",
  "kernel.status",
]);
const SEARCH_RESOURCE_NAMES = new Set([
  "mindInvocations", "inputTokens", "outputTokens", "wallMillis", "singleInvocationMillis",
  "generatedBytes", "forgeCpuMillis", "forgeWallMillis", "memorySeconds", "writableBytes",
  "writableInodes", "artifactBytes", "networkBytes", "concurrentLineages", "totalAssayCost",
]);
const EVIDENCE_TYPES = new Set([
  "subject_snapshot",
  "tool_observation",
  "sandbox_execution",
  "original_subject_assertions",
  "artifact",
  "model_report",
  "peer_report",
  "memory_hint",
]);
const CANDIDATE_STATUSES = new Set(["proposed", "embodied", "invalidated", "survived", "selected"]);
const CANDIDATE_FEASIBILITIES = new Set(["BUILDABLE_NOW", "BRIDGEABLE", "LAWFUL_BUT_OPEN", "CONTRADICTED"]);
const ASSAY_STATUSES = new Set(["planned", "running", "passed", "failed", "inconclusive", "blocked"]);
const MAX_EVENT_IDENTIFIER_LENGTH = 256;
const MAX_EVENT_SUMMARY_LENGTH = 32_768;
const MAX_EVENT_REFERENCES = 256;
const MAX_CASE_COLLECTION_ENTRIES = 100_000;
const SUBJECT_MEDIA_TYPE = /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+(?:;[ \t]*[a-z0-9!#$%&'*+.^_`|~-]+=(?:[a-z0-9!#$%&'*+.^_`|~-]+|"(?:[\t !#-\[\]-~]|\\[\t -~])*"))*$/iu;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problem(problems: ProtocolProblem[], path: string, code: string, message: string): void {
  problems.push({ path, code, message });
}

/**
 * Copy only enumerable own data properties. Reading the returned null-prototype
 * record can never invoke accessors from an untrusted protocol object.
 */
function inertRecord(
  value: unknown,
  path: string,
  problems: ProtocolProblem[],
): Record<string, unknown> | undefined {
  if (!object(value)) {
    problem(problems, path, "invalid_type", "must be a plain object");
    return undefined;
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch {
    problem(problems, path, "invalid_object", "object metadata could not be inspected safely");
    return undefined;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    problem(problems, path, "invalid_object", "must use a plain or null prototype");
    return undefined;
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") {
      problem(problems, path, "symbol_field", "symbol fields are not part of the protocol");
      continue;
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      problem(problems, `${path}.${key}`, "invalid_property", "fields must be enumerable own data properties");
      continue;
    }
    result[key] = descriptor.value;
  }
  return result;
}

/** Inspect a dense intrinsic array without reading an indexed accessor. */
function inertArray(
  value: unknown,
  path: string,
  maximum: number,
  problems: ProtocolProblem[],
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    problem(problems, path, "invalid_array", "must be an array");
    return undefined;
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch {
    problem(problems, path, "invalid_array", "array metadata could not be inspected safely");
    return undefined;
  }
  if (prototype !== Array.prototype) {
    problem(problems, path, "invalid_array", "must use the intrinsic array prototype");
    return undefined;
  }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    problem(problems, path, "invalid_array", "array length is invalid");
    return undefined;
  }
  const length = lengthDescriptor.value as number;
  if (length > maximum) {
    problem(problems, path, "too_large", `must contain at most ${maximum} entries`);
    return undefined;
  }
  const expectedKeys = new Set<PropertyKey>(["length"]);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    expectedKeys.add(key);
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      problem(problems, `${path}[${index}]`, "invalid_property", "entries must be dense enumerable own data properties");
      continue;
    }
    result.push(descriptor.value);
  }
  for (const key of keys) {
    if (!expectedKeys.has(key)) {
      problem(
        problems,
        typeof key === "string" ? `${path}.${key}` : path,
        typeof key === "symbol" ? "symbol_field" : "unknown_field",
        "array has a field outside its dense indexed entries",
      );
    }
  }
  return result.length === length ? result : undefined;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, problems: ProtocolProblem[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problem(problems, `${path}.${key}`, "unknown_field", "field is not part of this protocol version");
  }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function boundedIdentifier(
  value: unknown,
  path: string,
  problems: ProtocolProblem[],
): value is string {
  if (!nonEmptyString(value) || (value as string).length > MAX_EVENT_IDENTIFIER_LENGTH) {
    problem(
      problems,
      path,
      "invalid_id",
      `must be a non-empty string of at most ${MAX_EVENT_IDENTIFIER_LENGTH} characters`,
    );
    return false;
  }
  return true;
}

function boundedSummary(value: unknown, path: string, problems: ProtocolProblem[]): void {
  if (!nonEmptyString(value)) {
    problem(problems, path, "invalid_summary", "summary must be a non-empty string");
  } else if ((value as string).length > MAX_EVENT_SUMMARY_LENGTH) {
    problem(
      problems,
      path,
      "too_large",
      `summary must contain at most ${MAX_EVENT_SUMMARY_LENGTH} characters`,
    );
  }
}

function identifierArray(
  value: unknown,
  path: string,
  problems: ProtocolProblem[],
): readonly string[] | undefined {
  const entries = inertArray(value, path, MAX_EVENT_REFERENCES, problems);
  if (entries === undefined) return undefined;
  const identifiers: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = entries[index];
    if (!boundedIdentifier(entry, entryPath, problems)) continue;
    if (seen.has(entry)) {
      problem(problems, entryPath, "duplicate", "identifier arrays must not contain duplicates");
      continue;
    }
    seen.add(entry);
    identifiers.push(entry);
  }
  return identifiers.length === entries.length ? identifiers : undefined;
}

function digestArray(
  value: unknown,
  path: string,
  problems: ProtocolProblem[],
): readonly string[] | undefined {
  const entries = inertArray(value, path, MAX_EVENT_REFERENCES, problems);
  if (entries === undefined) return undefined;
  const digests: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = entries[index];
    if (!isSha256Digest(entry)) {
      problem(problems, entryPath, "invalid_digest", "must be a SHA-256 digest");
      continue;
    }
    if (seen.has(entry)) {
      problem(problems, entryPath, "duplicate", "digest arrays must not contain duplicates");
      continue;
    }
    seen.add(entry);
    digests.push(entry);
  }
  return digests.length === entries.length ? digests : undefined;
}

function optionalStringArray(value: unknown, path: string, problems: ProtocolProblem[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    problem(problems, path, "invalid_string_array", "must be an array of non-empty strings");
  }
}

const INTENT_CONTRACT_FIELDS = [
  "protocol",
  "compilerVersion",
  "originalImpulse",
  "originalImpulseDigest",
  "goal",
  "subjectIds",
  "explicitConstraints",
  "requestedAssays",
  "successConditions",
  "failureConditions",
  "ambiguities",
  "alternativeInterpretations",
  "criticalObligations",
  "digest",
] as const;

function requiredStringArray(value: unknown, path: string, problems: ProtocolProblem[]): void {
  if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item))) {
    problem(problems, path, "invalid_string_array", "must be an array of non-empty strings");
  }
}

export function validateIntentContract(value: unknown): ValidationResult<IntentContract> {
  const problems: ProtocolProblem[] = [];
  if (!object(value)) return { ok: false, problems: [{ path: "$", code: "invalid_type", message: "intent contract must be an object" }] };
  rejectUnknownKeys(value, new Set(INTENT_CONTRACT_FIELDS), "$", problems);
  for (const field of INTENT_CONTRACT_FIELDS) if (value[field] === undefined) problem(problems, `$.${field}`, "required", "field is required");
  if (value.protocol !== INTENT_CONTRACT_PROTOCOL) problem(problems, "$.protocol", "unsupported_protocol", `must equal ${INTENT_CONTRACT_PROTOCOL}`);
  if (value.compilerVersion !== INTENT_COMPILER_VERSION) problem(problems, "$.compilerVersion", "unsupported_compiler", `must equal ${INTENT_COMPILER_VERSION}`);
  if (!nonEmptyString(value.originalImpulse)) problem(problems, "$.originalImpulse", "invalid_impulse", "originalImpulse must be non-empty");
  if (!isSha256Digest(value.originalImpulseDigest)) {
    problem(problems, "$.originalImpulseDigest", "invalid_digest", "originalImpulseDigest must be a SHA-256 digest");
  } else if (typeof value.originalImpulse === "string" && sha256Digest(value.originalImpulse) !== value.originalImpulseDigest) {
    problem(problems, "$.originalImpulseDigest", "digest_mismatch", "originalImpulseDigest does not bind the exact impulse bytes");
  }
  if (!isSha256Digest(value.digest)) problem(problems, "$.digest", "invalid_digest", "digest must be a SHA-256 digest");

  if (!object(value.goal)) {
    problem(problems, "$.goal", "invalid_type", "goal must be an object");
  } else {
    rejectUnknownKeys(value.goal, new Set(["statement", "source"]), "$.goal", problems);
    if (!nonEmptyString(value.goal.statement)) problem(problems, "$.goal.statement", "invalid_statement", "goal statement must be non-empty");
    if (!["whole_impulse", "impulse_prefix"].includes(value.goal.source as string)) problem(problems, "$.goal.source", "invalid_enum", "unknown goal source");
  }
  requiredStringArray(value.subjectIds, "$.subjectIds", problems);
  requiredStringArray(value.requestedAssays, "$.requestedAssays", problems);

  const allIds = new Set<string>();
  const registerId = (entry: Record<string, unknown>, path: string) => {
    if (!nonEmptyString(entry.id)) return problem(problems, `${path}.id`, "invalid_id", "id must be a non-empty string");
    if (allIds.has(entry.id as string)) problem(problems, `${path}.id`, "duplicate", "ids must be unique across the contract");
    allIds.add(entry.id as string);
  };

  if (!Array.isArray(value.explicitConstraints)) {
    problem(problems, "$.explicitConstraints", "invalid_type", "explicitConstraints must be an array");
  } else value.explicitConstraints.forEach((entry, index) => {
    const path = `$.explicitConstraints[${index}]`;
    if (!object(entry)) return problem(problems, path, "invalid_type", "constraint must be an object");
    rejectUnknownKeys(entry, new Set(["id", "statement", "origin"]), path, problems);
    registerId(entry, path);
    if (!nonEmptyString(entry.statement)) problem(problems, `${path}.statement`, "invalid_statement", "statement must be non-empty");
    if (!["impulse", "declared_constraint"].includes(entry.origin as string)) problem(problems, `${path}.origin`, "invalid_enum", "unknown constraint origin");
  });

  const validateConditions = (entries: unknown, kind: "success" | "failure") => {
    const root = kind === "success" ? "$.successConditions" : "$.failureConditions";
    if (!Array.isArray(entries)) return problem(problems, root, "invalid_type", `${kind} conditions must be an array`);
    entries.forEach((entry, index) => {
      const path = `${root}[${index}]`;
      if (!object(entry)) return problem(problems, path, "invalid_type", "condition must be an object");
      rejectUnknownKeys(entry, new Set(["id", "kind", "statement", "source", "obligationIds"]), path, problems);
      registerId(entry, path);
      if (entry.kind !== kind) problem(problems, `${path}.kind`, "invalid_enum", `condition kind must be ${kind}`);
      if (!nonEmptyString(entry.statement)) problem(problems, `${path}.statement`, "invalid_statement", "statement must be non-empty");
      if (!["kernel", "impulse"].includes(entry.source as string)) problem(problems, `${path}.source`, "invalid_enum", "unknown condition source");
      requiredStringArray(entry.obligationIds, `${path}.obligationIds`, problems);
    });
  };
  validateConditions(value.successConditions, "success");
  validateConditions(value.failureConditions, "failure");

  const ambiguityIds = new Set<string>();
  if (!Array.isArray(value.ambiguities)) {
    problem(problems, "$.ambiguities", "invalid_type", "ambiguities must be an array");
  } else value.ambiguities.forEach((entry, index) => {
    const path = `$.ambiguities[${index}]`;
    if (!object(entry)) return problem(problems, path, "invalid_type", "ambiguity must be an object");
    rejectUnknownKeys(entry, new Set(["id", "code", "sourceText", "summary"]), path, problems);
    registerId(entry, path);
    if (typeof entry.id === "string") ambiguityIds.add(entry.id);
    if (!["DEICTIC_REFERENCE", "DISJUNCTION_SCOPE", "MODAL_FORCE", "OPEN_SCOPE", "SUBJECTIVE_PREDICATE"].includes(entry.code as string)) problem(problems, `${path}.code`, "invalid_enum", "unknown ambiguity code");
    if (!nonEmptyString(entry.sourceText) || !nonEmptyString(entry.summary)) problem(problems, path, "invalid_ambiguity", "sourceText and summary must be non-empty");
  });

  if (!Array.isArray(value.alternativeInterpretations)) {
    problem(problems, "$.alternativeInterpretations", "invalid_type", "alternativeInterpretations must be an array");
  } else value.alternativeInterpretations.forEach((entry, index) => {
    const path = `$.alternativeInterpretations[${index}]`;
    if (!object(entry)) return problem(problems, path, "invalid_type", "alternative interpretation must be an object");
    rejectUnknownKeys(entry, new Set(["id", "ambiguityId", "statement", "resolution"]), path, problems);
    registerId(entry, path);
    if (!nonEmptyString(entry.ambiguityId) || !ambiguityIds.has(entry.ambiguityId as string)) problem(problems, `${path}.ambiguityId`, "unknown_reference", "ambiguityId must reference a contract ambiguity");
    if (!nonEmptyString(entry.statement)) problem(problems, `${path}.statement`, "invalid_statement", "statement must be non-empty");
    if (entry.resolution !== "UNRESOLVED") problem(problems, `${path}.resolution`, "invalid_resolution", "deterministic compiler alternatives must remain UNRESOLVED");
  });

  const obligationIds = new Set<string>();
  if (!Array.isArray(value.criticalObligations) || value.criticalObligations.length === 0) {
    problem(problems, "$.criticalObligations", "invalid_type", "criticalObligations must be a non-empty array");
  } else value.criticalObligations.forEach((entry, index) => {
    const path = `$.criticalObligations[${index}]`;
    if (!object(entry)) return problem(problems, path, "invalid_type", "obligation must be an object");
    rejectUnknownKeys(entry, new Set(["id", "statement", "origin", "critical", "assayability", "oracle", "unassayableReason"]), path, problems);
    registerId(entry, path);
    if (typeof entry.id === "string") obligationIds.add(entry.id);
    if (!nonEmptyString(entry.statement)) problem(problems, `${path}.statement`, "invalid_statement", "statement must be non-empty");
    if (!["impulse", "declared_constraint", "requested_assay"].includes(entry.origin as string)) problem(problems, `${path}.origin`, "invalid_enum", "unknown obligation origin");
    if (entry.critical !== true) problem(problems, `${path}.critical`, "invalid_criticality", "compiled obligations must be critical");
    if (!["ASSAYABLE", "UNASSAYABLE"].includes(entry.assayability as string)) problem(problems, `${path}.assayability`, "invalid_enum", "unknown assayability");
    if (entry.assayability === "ASSAYABLE" && !object(entry.oracle)) problem(problems, `${path}.oracle`, "required", "assayable obligation requires an oracle");
    if (entry.assayability === "UNASSAYABLE" && entry.oracle !== undefined) problem(problems, `${path}.oracle`, "forbidden", "unassayable obligation cannot have an oracle");
    if (entry.assayability === "UNASSAYABLE" && !nonEmptyString(entry.unassayableReason)) problem(problems, `${path}.unassayableReason`, "required", "unassayable obligation requires a reason");
    if (object(entry.oracle)) {
      rejectUnknownKeys(entry.oracle, new Set(["kind", "operand", "operator", "expected"]), `${path}.oracle`, problems);
      if (!["command_exit_code", "exact_output", "network_access_count", "output_parse", "path_exists", "sealed_subject_digest", "sealed_test_suite", "requested_assay"].includes(entry.oracle.kind as string)) problem(problems, `${path}.oracle.kind`, "invalid_enum", "unknown oracle kind");
      if (!nonEmptyString(entry.oracle.operand) || !nonEmptyString(entry.oracle.expected)) problem(problems, `${path}.oracle`, "invalid_oracle", "oracle operand and expected must be non-empty");
      if (!["equals", "exists", "passes", "parses_as", "unchanged"].includes(entry.oracle.operator as string)) problem(problems, `${path}.oracle.operator`, "invalid_enum", "unknown oracle operator");
    }
  });

  for (const collection of [value.successConditions, value.failureConditions]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      if (!object(entry) || !Array.isArray(entry.obligationIds)) continue;
      for (const obligationId of entry.obligationIds) {
        if (typeof obligationId === "string" && !obligationIds.has(obligationId)) problem(problems, "$.conditions.obligationIds", "unknown_reference", `unknown obligation ${obligationId}`);
      }
    }
  }

  if (isSha256Digest(value.digest)) {
    const { digest: _ignored, ...unsigned } = value;
    const expected = digestJson(unsigned as unknown as JsonValue);
    if (expected !== value.digest) problem(problems, "$.digest", "digest_mismatch", "digest does not bind the canonical intent contract");
  }
  return problems.length === 0 ? { ok: true, value: value as unknown as IntentContract, problems } : { ok: false, problems };
}

export function assertIntentContractShape(value: unknown): asserts value is IntentContract {
  const result = validateIntentContract(value);
  if (!result.ok) throw new TypeError(`Invalid Jevyr intent contract: ${result.problems.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
}

const SEARCH_PROFILE_FIELDS = [
  "attemptSafetyCeiling",
  "nursery",
  "resources",
  "seedDerivation",
] as const;

const SEARCH_NURSERY_FIELDS = ["minimumAttempts", "saturationWindow", "independentLineages", "challengeInterval"] as const;
const SEARCH_RESOURCE_FIELDS = [
  "maxMindInvocations",
  "maxInputTokens",
  "maxOutputTokens",
  "maxWallMillis",
  "maxSingleInvocationMillis",
  "maxGeneratedBytes",
  "maxForgeCpuMillis",
  "maxForgeWallMillis",
  "maxMemorySeconds",
  "maxWritableBytes",
  "maxWritableInodes",
  "maxArtifactBytes",
  "maxNetworkBytes",
  "concurrentLineages",
  "maxTotalAssayCost",
] as const;

export function validateSearchEnvelope(value: unknown): ValidationResult<SearchEnvelope> {
  const problems: ProtocolProblem[] = [];
  if (!object(value)) {
    return { ok: false, problems: [{ path: "$", code: "invalid_type", message: "search envelope must be an object" }] };
  }
  rejectUnknownKeys(value, new Set(["protocol", "profile", "digest"]), "$", problems);
  if (value.protocol !== SEARCH_ENVELOPE_PROTOCOL) {
    problem(problems, "$.protocol", "unsupported_protocol", `must equal ${SEARCH_ENVELOPE_PROTOCOL}`);
  }
  if (!isSha256Digest(value.digest)) problem(problems, "$.digest", "invalid_digest", "digest must be a SHA-256 digest");
  if (!object(value.profile)) {
    problem(problems, "$.profile", "invalid_type", "profile must be an object");
  } else {
    rejectUnknownKeys(value.profile, new Set(SEARCH_PROFILE_FIELDS), "$.profile", problems);
    for (const field of SEARCH_PROFILE_FIELDS) {
      if (value.profile[field] === undefined) problem(problems, `$.profile.${field}`, "required", "field is required");
    }
    if (
      typeof value.profile.attemptSafetyCeiling !== "string" ||
      value.profile.attemptSafetyCeiling.length > 128 ||
      !/^[1-9][0-9]*$/u.test(value.profile.attemptSafetyCeiling)
    ) {
      problem(problems, "$.profile.attemptSafetyCeiling", "invalid_ceiling", "attemptSafetyCeiling must be a positive decimal string of at most 128 digits");
    }
    if (!object(value.profile.nursery)) {
      problem(problems, "$.profile.nursery", "invalid_type", "nursery must be an object");
    } else {
      rejectUnknownKeys(value.profile.nursery, new Set(SEARCH_NURSERY_FIELDS), "$.profile.nursery", problems);
      for (const field of SEARCH_NURSERY_FIELDS) {
        if (value.profile.nursery[field] === undefined) problem(problems, `$.profile.nursery.${field}`, "required", "field is required");
        const minimum = field === "saturationWindow" ? 0 : 1;
        if (!Number.isSafeInteger(value.profile.nursery[field]) || (value.profile.nursery[field] as number) < minimum) {
          problem(problems, `$.profile.nursery.${field}`, "invalid_counter", `${field} must be a safe integer of at least ${minimum}`);
        }
      }
    }
    if (!object(value.profile.resources)) {
      problem(problems, "$.profile.resources", "invalid_type", "resources must be an object");
    } else {
      rejectUnknownKeys(value.profile.resources, new Set(SEARCH_RESOURCE_FIELDS), "$.profile.resources", problems);
      for (const field of SEARCH_RESOURCE_FIELDS) {
        if (value.profile.resources[field] === undefined) problem(problems, `$.profile.resources.${field}`, "required", "field is required");
        const resource = value.profile.resources[field];
        if (!Number.isSafeInteger(resource) || (resource as number) < 0) {
          problem(problems, `$.profile.resources.${field}`, "invalid_resource_limit", `${field} must be a non-negative safe integer`);
        }
      }
      const concurrency = value.profile.resources.concurrentLineages;
      if (Number.isSafeInteger(concurrency) && (concurrency as number) < 1) {
        problem(problems, "$.profile.resources.concurrentLineages", "invalid_resource_limit", "concurrentLineages must be at least one");
      }
      if (
        object(value.profile.nursery) &&
        Number.isSafeInteger(value.profile.nursery.independentLineages) &&
        Number.isSafeInteger(concurrency) &&
        (concurrency as number) > (value.profile.nursery.independentLineages as number)
      ) {
        problem(problems, "$.profile.resources.concurrentLineages", "invalid_resource_limit", "concurrentLineages cannot exceed independentLineages");
      }
      const single = value.profile.resources.maxSingleInvocationMillis;
      const total = value.profile.resources.maxWallMillis;
      if (Number.isSafeInteger(single) && Number.isSafeInteger(total) && (single as number) > (total as number)) {
        problem(problems, "$.profile.resources.maxSingleInvocationMillis", "invalid_resource_limit", "maxSingleInvocationMillis cannot exceed maxWallMillis");
      }
    }
    if (!["sha256-run-digest-frontier-v1", "sha256-case-seed-frontier-v2"].includes(String(value.profile.seedDerivation))) {
      problem(problems, "$.profile.seedDerivation", "invalid_seed_derivation", "unknown seed derivation rule");
    }
    if (isSha256Digest(value.digest)) {
      const expected = digestJson({ protocol: SEARCH_ENVELOPE_PROTOCOL, profile: value.profile as unknown as JsonValue });
      if (value.digest !== expected) problem(problems, "$.digest", "digest_mismatch", "digest does not bind the canonical search profile");
    }
  }
  return problems.length === 0
    ? { ok: true, value: value as unknown as SearchEnvelope, problems }
    : { ok: false, problems };
}

export function assertSearchEnvelope(value: unknown): asserts value is SearchEnvelope {
  const result = validateSearchEnvelope(value);
  if (!result.ok) {
    throw new TypeError(`Invalid Jevyr search envelope: ${result.problems.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  }
}

export function validateSealReceipt(value: unknown): ValidationResult<SealReceipt> {
  const problems: ProtocolProblem[] = [];
  if (!object(value)) return { ok: false, problems: [{ path: "$", code: "invalid_type", message: "seal receipt must be an object" }] };
  const fields = ["protocol", "caseId", "submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "sealedAt", "policyVersion", "policyDigest", "genomeVersion", "genomeDigest", "searchDigest", "intentContractDigest"];
  rejectUnknownKeys(value, new Set(fields), "$", problems);
  for (const field of fields) if (value[field] === undefined) problem(problems, `$.${field}`, "required", "field is required");
  if (value.protocol !== "jevyr.seal/1") problem(problems, "$.protocol", "unsupported_protocol", "must equal jevyr.seal/1");
  if (!nonEmptyString(value.caseId)) problem(problems, "$.caseId", "invalid_id", "caseId must be non-empty");
  for (const field of ["submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest"] as const) {
    if (!isSha256Digest(value[field])) problem(problems, `$.${field}`, "invalid_digest", `${field} must be a SHA-256 digest`);
  }
  if (!nonEmptyString(value.policyVersion)) problem(problems, "$.policyVersion", "invalid_version", "policyVersion must be non-empty");
  if (!nonEmptyString(value.genomeVersion)) problem(problems, "$.genomeVersion", "invalid_version", "genomeVersion must be non-empty");
  if (!canonicalTimestamp(value.sealedAt)) problem(problems, "$.sealedAt", "invalid_time", "sealedAt must be a canonical UTC timestamp with millisecond precision");
  if (isSha256Digest(value.runDigest) && typeof value.caseId === "string" && value.caseId !== `case_${value.runDigest.slice(7, 23)}`) {
    problem(problems, "$.caseId", "identity_mismatch", "caseId is not derived from runDigest");
  }
  return problems.length === 0 ? { ok: true, value: value as unknown as SealReceipt, problems } : { ok: false, problems };
}

const NORMALIZED_INTENT_FIELDS = [
  "impulse",
  "mode",
  "subjects",
  "constraints",
  "requestedAssays",
  "privacy",
  "control",
  "seed",
] as const;
const SUBJECT_REFERENCE_FIELDS = ["id", "kind", "locator"] as const;
const SUBJECT_REFERENCE_OPTIONAL_FIELDS = ["revision", "mediaType"] as const;
const SUBJECT_SNAPSHOT_FIELDS = ["subjectId", "digest", "resolvedLocator", "capturedAt"] as const;
const SUBJECT_SNAPSHOT_OPTIONAL_FIELDS = ["revision", "byteLength", "mediaType"] as const;

function exactObjectFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  problems: ProtocolProblem[],
): void {
  for (const field of required) {
    if (!Object.hasOwn(value, field)) problem(problems, `${path}.${field}`, "required", "field is required");
  }
  rejectUnknownKeys(value, new Set([...required, ...optional]), path, problems);
}

function canonicalNonEmptyString(
  value: unknown,
  path: string,
  problems: ProtocolProblem[],
  label: string,
): value is string {
  if (!nonEmptyString(value)) {
    problem(problems, path, "invalid_type", `${label} must be a non-empty string`);
    return false;
  }
  if ((value as string) !== (value as string).trim()) {
    problem(problems, path, "noncanonical", `${label} must not have leading or trailing whitespace`);
    return false;
  }
  return true;
}

function canonicalStringArray(
  value: unknown,
  path: string,
  problems: ProtocolProblem[],
): readonly string[] | undefined {
  const entries = inertArray(value, path, MAX_CASE_COLLECTION_ENTRIES, problems);
  if (entries === undefined) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  let previous: string | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = entries[index];
    if (!canonicalNonEmptyString(entry, entryPath, problems, "entry")) continue;
    if (seen.has(entry)) problem(problems, entryPath, "duplicate", "entries must be unique");
    if (previous !== undefined && entry < previous) {
      problem(problems, entryPath, "out_of_order", "entries must be sorted in canonical code-unit order");
    }
    seen.add(entry);
    previous = entry;
    result.push(entry);
  }
  return result.length === entries.length ? result : undefined;
}

function validSubjectMediaType(value: unknown, path: string, problems: ProtocolProblem[]): value is string {
  if (typeof value !== "string" || value.length > 200 || !SUBJECT_MEDIA_TYPE.test(value)) {
    problem(problems, path, "invalid_media_type", "mediaType must be a canonical Internet media type of at most 200 characters");
    return false;
  }
  return true;
}

function validateSubjectReferences(
  value: unknown,
  path: string,
  problems: ProtocolProblem[],
): readonly SubjectReference[] | undefined {
  const entries = inertArray(value, path, MAX_CASE_COLLECTION_ENTRIES, problems);
  if (entries === undefined) return undefined;
  const subjects: SubjectReference[] = [];
  const seen = new Set<string>();
  let previousId: string | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const before = problems.length;
    const subject = inertRecord(entries[index], entryPath, problems);
    if (!subject) continue;
    exactObjectFields(subject, SUBJECT_REFERENCE_FIELDS, SUBJECT_REFERENCE_OPTIONAL_FIELDS, entryPath, problems);
    if (canonicalNonEmptyString(subject.id, `${entryPath}.id`, problems, "subject id")) {
      const id = subject.id;
      if (seen.has(id)) problem(problems, `${entryPath}.id`, "duplicate", "subject ids must be unique");
      if (previousId !== undefined && previousId.localeCompare(id) > 0) {
        problem(problems, `${entryPath}.id`, "out_of_order", "subjects must be sorted by id");
      }
      seen.add(id);
      previousId = id;
    }
    if (!SUBJECT_KINDS.has(subject.kind as string)) problem(problems, `${entryPath}.kind`, "invalid_enum", "unknown subject kind");
    canonicalNonEmptyString(subject.locator, `${entryPath}.locator`, problems, "subject locator");
    if (Object.hasOwn(subject, "revision")) canonicalNonEmptyString(subject.revision, `${entryPath}.revision`, problems, "subject revision");
    if (Object.hasOwn(subject, "mediaType")) validSubjectMediaType(subject.mediaType, `${entryPath}.mediaType`, problems);
    if (problems.length === before) subjects.push(subject as unknown as SubjectReference);
  }
  return subjects.length === entries.length ? subjects : undefined;
}

function validateNormalizedIntent(
  value: unknown,
  problems: ProtocolProblem[],
): NormalizedCaseIntent | undefined {
  const path = "$.intent";
  const before = problems.length;
  const intent = inertRecord(value, path, problems);
  if (!intent) return undefined;
  exactObjectFields(intent, NORMALIZED_INTENT_FIELDS, [], path, problems);
  if (canonicalNonEmptyString(intent.impulse, `${path}.impulse`, problems, "impulse")
    && (intent.impulse as string).length > 100_000) {
    problem(problems, `${path}.impulse`, "too_large", "impulse exceeds 100000 characters");
  }
  if (!MODES.has(intent.mode as string)) problem(problems, `${path}.mode`, "invalid_enum", "unknown case mode");
  if (!PRIVACY.has(intent.privacy as string)) problem(problems, `${path}.privacy`, "invalid_enum", "unknown privacy mode");
  if (!CONTROL.has(intent.control as string)) problem(problems, `${path}.control`, "invalid_enum", "unknown control mode");
  canonicalNonEmptyString(intent.seed, `${path}.seed`, problems, "seed");
  validateSubjectReferences(intent.subjects, `${path}.subjects`, problems);
  canonicalStringArray(intent.constraints, `${path}.constraints`, problems);
  canonicalStringArray(intent.requestedAssays, `${path}.requestedAssays`, problems);
  return problems.length === before ? intent as unknown as NormalizedCaseIntent : undefined;
}

function validateSubjectSnapshots(
  value: unknown,
  sealedAt: unknown,
  problems: ProtocolProblem[],
): readonly SubjectSnapshot[] | undefined {
  const path = "$.subjects";
  const entries = inertArray(value, path, MAX_CASE_COLLECTION_ENTRIES, problems);
  if (entries === undefined) return undefined;
  const snapshots: SubjectSnapshot[] = [];
  const seen = new Set<string>();
  let previousId: string | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const before = problems.length;
    const snapshot = inertRecord(entries[index], entryPath, problems);
    if (!snapshot) continue;
    exactObjectFields(snapshot, SUBJECT_SNAPSHOT_FIELDS, SUBJECT_SNAPSHOT_OPTIONAL_FIELDS, entryPath, problems);
    if (canonicalNonEmptyString(snapshot.subjectId, `${entryPath}.subjectId`, problems, "snapshot subjectId")) {
      const id = snapshot.subjectId;
      if (seen.has(id)) problem(problems, `${entryPath}.subjectId`, "duplicate", "snapshot subjectIds must be unique");
      if (previousId !== undefined && previousId.localeCompare(id) > 0) {
        problem(problems, `${entryPath}.subjectId`, "out_of_order", "snapshots must be sorted by subjectId");
      }
      seen.add(id);
      previousId = id;
    }
    if (!isSha256Digest(snapshot.digest)) problem(problems, `${entryPath}.digest`, "invalid_digest", "snapshot digest must be a SHA-256 digest");
    canonicalNonEmptyString(snapshot.resolvedLocator, `${entryPath}.resolvedLocator`, problems, "resolved locator");
    if (!canonicalTimestamp(snapshot.capturedAt)) {
      problem(problems, `${entryPath}.capturedAt`, "invalid_time", "capturedAt must be a canonical UTC timestamp with millisecond precision");
    } else if (canonicalTimestamp(sealedAt) && Date.parse(snapshot.capturedAt) > Date.parse(sealedAt)) {
      problem(problems, `${entryPath}.capturedAt`, "invalid_time", "capturedAt cannot be later than sealedAt");
    }
    if (Object.hasOwn(snapshot, "revision")) canonicalNonEmptyString(snapshot.revision, `${entryPath}.revision`, problems, "snapshot revision");
    if (Object.hasOwn(snapshot, "byteLength")
      && (!Number.isSafeInteger(snapshot.byteLength) || (snapshot.byteLength as number) < 0)) {
      problem(problems, `${entryPath}.byteLength`, "invalid_byte_length", "byteLength must be a non-negative safe integer");
    }
    if (Object.hasOwn(snapshot, "mediaType")) validSubjectMediaType(snapshot.mediaType, `${entryPath}.mediaType`, problems);
    if (problems.length === before) snapshots.push(snapshot as unknown as SubjectSnapshot);
  }
  return snapshots.length === entries.length ? snapshots : undefined;
}

function validateSubjectCorrespondence(
  references: readonly SubjectReference[],
  snapshots: readonly SubjectSnapshot[],
  problems: ProtocolProblem[],
): void {
  if (references.length !== snapshots.length) {
    problem(problems, "$.subjects", "cardinality_mismatch", "every subject reference must have exactly one snapshot");
  }
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.subjectId, snapshot]));
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index] as SubjectReference;
    const snapshot = snapshotsById.get(reference.id);
    if (!snapshot) {
      problem(problems, `$.intent.subjects[${index}].id`, "missing_snapshot", `subject ${reference.id} has no snapshot`);
      continue;
    }
    if (snapshots[index]?.subjectId !== reference.id) {
      problem(problems, `$.subjects[${index}].subjectId`, "correspondence_mismatch", "snapshot order must exactly match intent subject order");
    }
    if (reference.mediaType !== undefined && snapshot.mediaType !== reference.mediaType) {
      problem(problems, `$.subjects[${index}].mediaType`, "correspondence_mismatch", "snapshot mediaType must preserve the declared subject mediaType");
    }
    if (reference.kind !== "git" && reference.revision !== undefined && snapshot.revision !== reference.revision) {
      problem(problems, `$.subjects[${index}].revision`, "correspondence_mismatch", "snapshot revision must preserve the declared subject revision");
    }
    if (reference.kind === "text") {
      const expectedDigest = sha256Digest(reference.locator);
      if (snapshot.digest !== expectedDigest) {
        problem(problems, `$.subjects[${index}].digest`, "digest_mismatch", "text snapshot digest does not bind the exact sealed text bytes");
      }
      if (snapshot.resolvedLocator !== `inline:${reference.id}`) {
        problem(problems, `$.subjects[${index}].resolvedLocator`, "correspondence_mismatch", "text snapshot must use its canonical inline locator");
      }
      const expectedByteLength = new TextEncoder().encode(reference.locator).byteLength;
      if (snapshot.byteLength !== expectedByteLength) {
        problem(problems, `$.subjects[${index}].byteLength`, "correspondence_mismatch", "text snapshot byteLength must equal its UTF-8 byte length");
      }
    }
  }
  const referenceIds = new Set(references.map((reference) => reference.id));
  snapshots.forEach((snapshot, index) => {
    if (!referenceIds.has(snapshot.subjectId)) {
      problem(problems, `$.subjects[${index}].subjectId`, "unknown_reference", `snapshot ${snapshot.subjectId} does not reference a sealed subject`);
    }
  });
}

export function validateSealedCase(value: unknown): ValidationResult<SealedCase> {
  const problems: ProtocolProblem[] = [];
  const sealed = inertRecord(value, "$", problems);
  if (!sealed) return { ok: false, problems };
  const fields = ["protocol", "caseId", "submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "sealedAt", "policyVersion", "policyDigest", "genomeVersion", "genomeDigest", "searchEnvelope", "intentContractDigest", "intentContract", "intent", "subjects"];
  exactObjectFields(sealed, fields, [], "$", problems);
  if (sealed.protocol !== CASE_PROTOCOL) problem(problems, "$.protocol", "unsupported_protocol", `must equal ${CASE_PROTOCOL}`);
  const receiptResult = validateSealReceipt({
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
    searchDigest: object(sealed.searchEnvelope) ? sealed.searchEnvelope.digest : undefined,
    intentContractDigest: sealed.intentContractDigest,
  });
  problems.push(...receiptResult.problems.map((entry) => ({ ...entry, path: entry.path === "$" ? "$" : entry.path })));
  const searchResult = validateSearchEnvelope(sealed.searchEnvelope);
  problems.push(...searchResult.problems.map((entry) => ({ ...entry, path: `$.searchEnvelope${entry.path.slice(1)}` })));
  const contractResult = validateIntentContract(sealed.intentContract);
  problems.push(...contractResult.problems.map((entry) => ({ ...entry, path: `$.intentContract${entry.path.slice(1)}` })));
  if (contractResult.ok && sealed.intentContractDigest !== contractResult.value?.digest) problem(problems, "$.intentContractDigest", "digest_mismatch", "intentContractDigest does not match intentContract.digest");
  const intent = validateNormalizedIntent(sealed.intent, problems);
  const snapshots = validateSubjectSnapshots(sealed.subjects, sealed.sealedAt, problems);
  const references = intent?.subjects;
  if (references !== undefined && snapshots !== undefined) {
    validateSubjectCorrespondence(references, snapshots, problems);
    if (contractResult.ok) {
      const contractSubjectIds = contractResult.value?.subjectIds ?? [];
      if (contractSubjectIds.length !== references.length
        || contractSubjectIds.some((id, index) => id !== references[index]?.id)) {
        problem(problems, "$.intentContract.subjectIds", "correspondence_mismatch", "intent contract subjectIds must exactly match the sealed subject references");
      }
    }
  }
  if (intent !== undefined && snapshots !== undefined
    && isSha256Digest(sealed.intentContractDigest) && isSha256Digest(sealed.subjectMaterialCaptureDigest)) {
    try {
      const expectedCaseDigest = sealedCaseIdentityDigest({
        intent,
        intentContractDigest: sealed.intentContractDigest,
        subjectMaterialCaptureDigest: sealed.subjectMaterialCaptureDigest,
        subjects: snapshots,
      });
      if (sealed.caseDigest !== expectedCaseDigest) {
        problem(problems, "$.caseDigest", "digest_mismatch", "caseDigest does not bind the sealed intent, snapshots, and subject material capture");
      }
    } catch {
      problem(problems, "$.caseDigest", "identity_unavailable", "sealed Case identity fields are not canonically encodable");
    }
  }
  if (receiptResult.ok && searchResult.ok && intent !== undefined) {
    try {
      const expectedRunDigest = digestJson({
        caseDigest: sealed.caseDigest as string,
        policyVersion: sealed.policyVersion as string,
        policyDigest: sealed.policyDigest as string,
        genomeVersion: sealed.genomeVersion as string,
        genomeDigest: sealed.genomeDigest as string,
        searchDigest: searchResult.value?.digest as string,
        seed: intent.seed,
        sealedAt: sealed.sealedAt as string,
      });
      if (sealed.runDigest !== expectedRunDigest) problem(problems, "$.runDigest", "digest_mismatch", "runDigest does not bind the sealed provenance");
    } catch {
      problem(problems, "$.runDigest", "identity_unavailable", "sealed Run identity fields are not canonically encodable");
    }
  }
  return problems.length === 0 ? { ok: true, value: value as unknown as SealedCase, problems } : { ok: false, problems };
}

export function validateSignedRecord(value: unknown): ValidationResult<SignedRecord> {
  const problems: ProtocolProblem[] = [];
  if (!object(value)) return { ok: false, problems: [{ path: "$", code: "invalid_type", message: "signed record must be an object" }] };
  const fields = ["protocol", "caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest", "eventHeadDigest", "verdict", "reflex", "memoryInfluences", "crystallizedAt"];
  rejectUnknownKeys(value, new Set(fields), "$", problems);
  for (const field of fields) if (value[field] === undefined) problem(problems, `$.${field}`, "required", "field is required");
  if (value.protocol !== RECORD_PROTOCOL) problem(problems, "$.protocol", "unsupported_protocol", `must equal ${RECORD_PROTOCOL}`);
  for (const field of ["caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest", "eventHeadDigest"] as const) {
    if (!isSha256Digest(value[field])) problem(problems, `$.${field}`, "invalid_digest", `${field} must be a SHA-256 digest`);
  }
  const verdict = inertRecord(value.verdict, "$.verdict", problems);
  if (verdict) {
    const verdictRequired = ["policyVersion", "intentContractDigest", "evidenceDigest", "integrity", "creation", "embodiment", "judgment", "feasibilityByCandidate", "basis"] as const;
    exactPayloadFields(verdict, verdictRequired, ["selectedCandidateId"], problems, "$.verdict");
    if (!nonEmptyString(verdict.policyVersion)) problem(problems, "$.verdict.policyVersion", "invalid_version", "policyVersion must be non-empty");
    if (!isSha256Digest(verdict.intentContractDigest) || verdict.intentContractDigest !== value.intentContractDigest) problem(problems, "$.verdict.intentContractDigest", "digest_mismatch", "verdict must bind the Record intentContractDigest");
    if (!isSha256Digest(verdict.evidenceDigest)) problem(problems, "$.verdict.evidenceDigest", "invalid_digest", "evidenceDigest must be a SHA-256 digest");
    if (!["VALID", "INVALID"].includes(verdict.integrity as string)) problem(problems, "$.verdict.integrity", "invalid_enum", "unknown integrity outcome");
    if (!["CONCEIVED", "NO_SURVIVOR", "FAILED"].includes(verdict.creation as string)) problem(problems, "$.verdict.creation", "invalid_enum", "unknown creation outcome");
    if (!["BUILT", "NOT_BUILT", "FAILED"].includes(verdict.embodiment as string)) problem(problems, "$.verdict.embodiment", "invalid_enum", "unknown embodiment outcome");
    if (!["ACCEPT", "REJECT", "UNPROVEN", "NOT_APPLICABLE"].includes(verdict.judgment as string)) problem(problems, "$.verdict.judgment", "invalid_enum", "unknown judgment outcome");
    if (Object.hasOwn(verdict, "selectedCandidateId")) boundedIdentifier(verdict.selectedCandidateId, "$.verdict.selectedCandidateId", problems);
    const feasibility = inertRecord(verdict.feasibilityByCandidate, "$.verdict.feasibilityByCandidate", problems);
    if (feasibility) {
      const entries = Object.entries(feasibility);
      if (entries.length > MAX_EVENT_REFERENCES) problem(problems, "$.verdict.feasibilityByCandidate", "too_large", `must contain at most ${MAX_EVENT_REFERENCES} candidates`);
      for (const [candidateId, outcome] of entries) {
        boundedIdentifier(candidateId, `$.verdict.feasibilityByCandidate.${candidateId}`, problems);
        if (!CANDIDATE_FEASIBILITIES.has(outcome as string)) problem(problems, `$.verdict.feasibilityByCandidate.${candidateId}`, "invalid_enum", "unknown candidate feasibility");
      }
    }
    const basis = inertArray(verdict.basis, "$.verdict.basis", MAX_EVENT_REFERENCES, problems);
    basis?.forEach((entry, index) => {
      const path = `$.verdict.basis[${index}]`;
      const item = inertRecord(entry, path, problems);
      if (!item) return;
      exactPayloadFields(item, ["code", "summary", "evidenceIds"], ["obligationIds", "candidateIds"], problems, path);
      boundedIdentifier(item.code, `${path}.code`, problems);
      boundedSummary(item.summary, `${path}.summary`, problems);
      identifierArray(item.evidenceIds, `${path}.evidenceIds`, problems);
      if (Object.hasOwn(item, "obligationIds")) identifierArray(item.obligationIds, `${path}.obligationIds`, problems);
      if (Object.hasOwn(item, "candidateIds")) identifierArray(item.candidateIds, `${path}.candidateIds`, problems);
    });
  }
  const reflex = inertRecord(value.reflex, "$.reflex", problems);
  if (reflex) {
    const nested: ProtocolProblem[] = [];
    validatePayload("reflex.completed", reflex, nested);
    problems.push(...nested.map((entry) => ({ ...entry, path: entry.path.replace(/^\$\.payload/u, "$.reflex") })));
    if (reflex.intentContractDigest !== value.intentContractDigest) problem(problems, "$.reflex.intentContractDigest", "digest_mismatch", "Reflex must bind the Record intentContractDigest");
  }
  const memories = inertArray(value.memoryInfluences, "$.memoryInfluences", MAX_EVENT_REFERENCES, problems);
  memories?.forEach((entry, index) => {
    const path = `$.memoryInfluences[${index}]`;
    const memory = inertRecord(entry, path, problems);
    if (!memory) return;
    const nested: ProtocolProblem[] = [];
    validatePayload("memory.influence", memory, nested);
    problems.push(...nested.map((item) => ({ ...item, path: item.path.replace(/^\$\.payload/u, path) })));
  });
  if (!canonicalTimestamp(value.crystallizedAt)) problem(problems, "$.crystallizedAt", "invalid_time", "crystallizedAt must be a canonical UTC timestamp with millisecond precision");
  return problems.length === 0 ? { ok: true, value: value as unknown as SignedRecord, problems } : { ok: false, problems };
}

export function validateTerminalReceipt(value: unknown): ValidationResult<TerminalReceipt> {
  const problems: ProtocolProblem[] = [];
  const receipt = inertRecord(value, "$", problems);
  if (receipt === undefined) return { ok: false, problems };
  const fields = [
    "protocol", "caseId", "caseDigest", "runDigest", "lifecycle", "stage",
    "stageStatus", "lastSequence", "eventHeadDigest", "recordDigest", "artifactIndexDigest", "closedAt",
  ] as const;
  exactObjectFields(receipt, fields, [], "$", problems);
  if (receipt.protocol !== TERMINAL_PROTOCOL) {
    problem(problems, "$.protocol", "unsupported_protocol", `must equal ${TERMINAL_PROTOCOL}`);
  }
  if (!nonEmptyString(receipt.caseId)) problem(problems, "$.caseId", "invalid_id", "caseId must be non-empty");
  for (const field of ["caseDigest", "runDigest", "recordDigest", "artifactIndexDigest"] as const) {
    if (!isSha256Digest(receipt[field])) {
      problem(problems, `$.${field}`, "invalid_digest", `${field} must be a SHA-256 digest`);
    }
  }
  if (receipt.lifecycle !== "terminated" && receipt.lifecycle !== "invalid") {
    problem(problems, "$.lifecycle", "invalid_enum", "lifecycle must be terminated or invalid");
  }
  if (!(LIFECYCLE_STAGES as readonly unknown[]).includes(receipt.stage)) {
    problem(problems, "$.stage", "invalid_enum", "stage is not a Jevyr lifecycle stage");
  }
  if (!["entered", "working", "completed", "failed", "skipped"].includes(receipt.stageStatus as string)) {
    problem(problems, "$.stageStatus", "invalid_enum", "stageStatus is not a Jevyr stage status");
  }
  if (!Number.isSafeInteger(receipt.lastSequence) || (receipt.lastSequence as number) < 0) {
    problem(problems, "$.lastSequence", "invalid_counter", "lastSequence must be a non-negative safe integer");
  }
  if (receipt.eventHeadDigest !== null && !isSha256Digest(receipt.eventHeadDigest)) {
    problem(problems, "$.eventHeadDigest", "invalid_digest", "eventHeadDigest must be null or a SHA-256 digest");
  }
  if (receipt.lastSequence === 0 && receipt.eventHeadDigest !== null) {
    problem(problems, "$.eventHeadDigest", "head_mismatch", "an empty terminal ledger must have a null event head");
  }
  if (typeof receipt.lastSequence === "number" && receipt.lastSequence > 0 && !isSha256Digest(receipt.eventHeadDigest)) {
    problem(problems, "$.eventHeadDigest", "head_mismatch", "a non-empty terminal ledger must have a SHA-256 event head");
  }
  if (!canonicalTimestamp(receipt.closedAt)) {
    problem(problems, "$.closedAt", "invalid_time", "closedAt must be a canonical UTC timestamp with millisecond precision");
  }
  if (isSha256Digest(receipt.runDigest)
    && typeof receipt.caseId === "string"
    && receipt.caseId !== `case_${receipt.runDigest.slice(7, 23)}`) {
    problem(problems, "$.caseId", "identity_mismatch", "caseId is not derived from runDigest");
  }
  if (receipt.lifecycle === "terminated"
    && (receipt.stage !== "terminate" || receipt.stageStatus !== "completed")) {
    problem(problems, "$", "invalid_terminal_state", "terminated closure must complete the terminate stage");
  }
  if (receipt.lifecycle === "invalid" && receipt.stageStatus !== "failed") {
    problem(problems, "$.stageStatus", "invalid_terminal_state", "invalid closure must have failed stage status");
  }
  return problems.length === 0
    ? { ok: true, value: receipt as unknown as TerminalReceipt, problems }
    : { ok: false, problems };
}

export function validateCaseSubmission(value: unknown): ValidationResult<CaseSubmission> {
  const problems: ProtocolProblem[] = [];
  if (!object(value)) {
    return { ok: false, problems: [{ path: "$", code: "invalid_type", message: "submission must be an object" }] };
  }
  rejectUnknownKeys(value, new Set(["protocol", "case"]), "$", problems);
  if (value.protocol !== CASE_PROTOCOL) problem(problems, "$.protocol", "unsupported_protocol", `must equal ${CASE_PROTOCOL}`);
  if (!object(value.case)) {
    problem(problems, "$.case", "invalid_type", "case must be an object");
    return { ok: false, problems };
  }
  const intent = value.case;
  rejectUnknownKeys(intent, new Set(["impulse", "mode", "subjects", "constraints", "requestedAssays", "privacy", "control", "seed"]), "$.case", problems);
  if (typeof intent.impulse !== "string" || intent.impulse.trim() === "") {
    problem(problems, "$.case.impulse", "required", "impulse must be a non-empty string");
  } else if (intent.impulse.length > 100_000) {
    problem(problems, "$.case.impulse", "too_large", "impulse exceeds 100000 characters");
  }
  if (intent.mode !== undefined && !MODES.has(intent.mode as string)) problem(problems, "$.case.mode", "invalid_enum", "unknown case mode");
  if (intent.privacy !== undefined && !PRIVACY.has(intent.privacy as string)) problem(problems, "$.case.privacy", "invalid_enum", "unknown privacy mode");
  if (intent.control !== undefined && !CONTROL.has(intent.control as string)) problem(problems, "$.case.control", "invalid_enum", "unknown control mode");
  if (intent.seed !== undefined && (typeof intent.seed !== "string" || intent.seed.trim() === "")) problem(problems, "$.case.seed", "invalid_seed", "seed must be a non-empty string");
  optionalStringArray(intent.constraints, "$.case.constraints", problems);
  optionalStringArray(intent.requestedAssays, "$.case.requestedAssays", problems);

  if (intent.subjects !== undefined) {
    if (!Array.isArray(intent.subjects)) {
      problem(problems, "$.case.subjects", "invalid_type", "subjects must be an array");
    } else {
      const ids = new Set<string>();
      intent.subjects.forEach((subject, index) => {
        const path = `$.case.subjects[${index}]`;
        if (!object(subject)) return problem(problems, path, "invalid_type", "subject must be an object");
        rejectUnknownKeys(subject, new Set(["id", "kind", "locator", "revision", "mediaType"]), path, problems);
        if (typeof subject.id !== "string" || subject.id.trim() === "") problem(problems, `${path}.id`, "required", "subject id is required");
        else if (ids.has(subject.id)) problem(problems, `${path}.id`, "duplicate", "subject ids must be unique");
        else ids.add(subject.id);
        if (!SUBJECT_KINDS.has(subject.kind as string)) problem(problems, `${path}.kind`, "invalid_enum", "unknown subject kind");
        if (typeof subject.locator !== "string" || subject.locator.trim() === "") problem(problems, `${path}.locator`, "required", "subject locator is required");
        if (subject.revision !== undefined && !nonEmptyString(subject.revision)) problem(problems, `${path}.revision`, "invalid_type", "revision must be a non-empty string");
        if (subject.mediaType !== undefined && !nonEmptyString(subject.mediaType)) problem(problems, `${path}.mediaType`, "invalid_type", "mediaType must be a non-empty string");
      });
    }
  }

  if (problems.length === 0 && !validateSubmissionSchema(value)) {
    for (const error of validateSubmissionSchema.errors ?? []) problem(problems, `$${error.instancePath}`, "schema_violation", error.message ?? "submission violates its shared schema");
  }
  return problems.length === 0
    ? { ok: true, value: value as unknown as CaseSubmission, problems }
    : { ok: false, problems };
}

export function assertCaseSubmission(value: unknown): asserts value is CaseSubmission {
  const result = validateCaseSubmission(value);
  if (!result.ok) {
    const message = result.problems.map((entry) => `${entry.path}: ${entry.message}`).join("; ");
    throw new TypeError(`Invalid Jevyr case submission: ${message}`);
  }
}

export function validateCaseEventShape(value: unknown): ValidationResult<CaseEvent> {
  const problems: ProtocolProblem[] = [];
  if (!object(value)) return { ok: false, problems: [{ path: "$", code: "invalid_type", message: "event must be an object" }] };
  const event = inertRecord(value, "$", problems);
  if (event === undefined) return { ok: false, problems };
  rejectUnknownKeys(event, new Set(["protocol", "caseDigest", "runDigest", "sequence", "priorDigest", "eventDigest", "observedAt", "stage", "kind", "actor", "payload"]), "$", problems);
  if (event.protocol !== EVENT_PROTOCOL) problem(problems, "$.protocol", "unsupported_protocol", `must equal ${EVENT_PROTOCOL}`);
  if (!isSha256Digest(event.caseDigest)) problem(problems, "$.caseDigest", "invalid_digest", "caseDigest must be a SHA-256 digest");
  if (!isSha256Digest(event.runDigest)) problem(problems, "$.runDigest", "invalid_digest", "runDigest must be a SHA-256 digest");
  if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1) problem(problems, "$.sequence", "invalid_sequence", "sequence must be a positive safe integer; cursor 0 means before the first event");
  if (event.priorDigest !== null && !isSha256Digest(event.priorDigest)) problem(problems, "$.priorDigest", "invalid_digest", "priorDigest must be null or a SHA-256 digest");
  if (!isSha256Digest(event.eventDigest)) problem(problems, "$.eventDigest", "invalid_digest", "eventDigest must be a SHA-256 digest");
  if (!canonicalTimestamp(event.observedAt)) problem(problems, "$.observedAt", "invalid_time", "observedAt must be a canonical UTC timestamp with millisecond precision");
  if (!LIFECYCLE_STAGES.includes(event.stage as never)) problem(problems, "$.stage", "invalid_stage", "unknown lifecycle stage");
  if (!EVENT_KINDS.has(event.kind as EventKind)) problem(problems, "$.kind", "invalid_kind", "unknown event kind");
  const actor = object(event.actor) ? inertRecord(event.actor, "$.actor", problems) : undefined;
  if (!actor || !boundedIdentifier(actor.id, "$.actor.id", problems) || !ACTOR_KINDS.has(actor.kind as string)) {
    problem(problems, "$.actor", "invalid_actor", "actor must expose a non-empty id and known kind");
  } else {
    rejectUnknownKeys(actor, new Set(["id", "kind", "instance"]), "$.actor", problems);
    if (Object.hasOwn(actor, "instance") && typeof actor.instance !== "string") {
      problem(problems, "$.actor.instance", "invalid_type", "actor instance must be a string when present");
    }
  }
  if (!object(event.payload)) {
    problem(problems, "$.payload", "invalid_payload", "payload must be an object");
  } else {
    const payload = inertRecord(event.payload, "$.payload", problems);
    if (payload && EVENT_KINDS.has(event.kind as EventKind)) {
      validatePayload(event.kind as EventKind, payload, problems);
      if (event.kind === "evidence.observed" && payload.evidenceType === "original_subject_assertions" && actor?.kind !== "kernel") problem(problems, "$.actor", "invalid_authority", "original-subject evidence requires a Bone actor");
    }
  }
  return problems.length === 0 ? { ok: true, value: value as unknown as CaseEvent, problems } : { ok: false, problems };
}

function requireFields(payload: Record<string, unknown>, fields: readonly string[], problems: ProtocolProblem[]): void {
  for (const field of fields) {
    if (!Object.hasOwn(payload, field)) problem(problems, `$.payload.${field}`, "required", "field is required for this event kind");
  }
}

function exactPayloadFields(
  payload: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  problems: ProtocolProblem[],
  path = "$.payload",
): void {
  for (const field of required) {
    if (!Object.hasOwn(payload, field)) problem(problems, `${path}.${field}`, "required", "field is required for this event kind");
  }
  rejectUnknownKeys(payload, new Set([...required, ...optional]), path, problems);
}

function validateFormalCounterexample(value: unknown, problems: ProtocolProblem[]): void {
  const path = "$.payload.formalProof";
  const proof = inertRecord(value, path, problems);
  if (!proof) return;
  exactPayloadFields(proof, ["protocol", "rule", "intentContractDigest", "obligationId", "statementDigest", "source", "proposition", "witness"], [], problems, path);
  if (proof.protocol !== "jevyr.formal-counterexample/1" || proof.rule !== "finite-sequence-length-lower-bound") problem(problems, path, "invalid_enum", "unknown formal proof rule or protocol");
  for (const key of ["intentContractDigest", "statementDigest"]) if (!isSha256Digest(proof[key])) problem(problems, `${path}.${key}`, "invalid_digest", "formal proof requires exact SHA-256 binding");
  boundedIdentifier(proof.obligationId, `${path}.obligationId`, problems);
  const source = inertRecord(proof.source, `${path}.source`, problems);
  if (source) {
    exactPayloadFields(source, ["start", "end", "text"], [], problems, `${path}.source`);
    for (const key of ["start", "end"]) if (!Number.isSafeInteger(source[key]) || Number(source[key]) < 0 || Number(source[key]) > 1_000_000) problem(problems, `${path}.source.${key}`, "invalid_type", "formal source offsets must be bounded nonnegative integers");
    boundedSummary(source.text, `${path}.source.text`, problems);
    if (typeof source.text === "string" && Number(source.end) - Number(source.start) !== source.text.length) problem(problems, `${path}.source`, "invalid_type", "source span length must equal exact source text length");
  }
  const proposition = inertRecord(proof.proposition, `${path}.proposition`, problems);
  if (proposition) {
    exactPayloadFields(proposition, ["domain", "minimumInputLength", "minimumOutputLength", "requiredSaving"], [], problems, `${path}.proposition`);
    if (!["all_finite_byte_strings", "all_finite_bit_strings"].includes(proposition.domain as string)) problem(problems, `${path}.proposition.domain`, "invalid_enum", "unknown finite sequence domain");
    if (proposition.minimumInputLength !== 0 || proposition.minimumOutputLength !== 0) problem(problems, `${path}.proposition`, "invalid_type", "this proof rule requires the empty input and natural output lengths");
    if (!Number.isSafeInteger(proposition.requiredSaving) || Number(proposition.requiredSaving) < 1 || Number(proposition.requiredSaving) > 999_999) problem(problems, `${path}.proposition.requiredSaving`, "invalid_type", "saving must be a bounded positive integer");
  }
  const witness = inertRecord(proof.witness, `${path}.witness`, problems);
  if (witness) {
    exactPayloadFields(witness, ["inputLength", "inputHex", "maximumOutputLength"], [], problems, `${path}.witness`);
    if (witness.inputLength !== 0 || witness.inputHex !== "") problem(problems, `${path}.witness`, "invalid_type", "this proof rule witnesses the empty sequence");
    if (!Number.isSafeInteger(witness.maximumOutputLength) || Number(witness.maximumOutputLength) >= 0 || Number(witness.maximumOutputLength) < -999_999) problem(problems, `${path}.witness.maximumOutputLength`, "invalid_type", "maximum output length must be a bounded negative integer");
  }
}

function validateInvestigationAudit(value: unknown, problems: ProtocolProblem[]): void {
  const path = "$.payload.audit";
  const audit = inertRecord(value, path, problems);
  if (!audit) return;
  const fields: Record<string, { ids?: string[]; digests?: string[]; references?: string[]; digestArrays?: string[]; enums?: Record<string, string[]>; booleans?: string[] }> = {
    lineage_commitment: { ids: ["invocationId", "providerId", "modelId", "lineageId"], digests: ["seedCommitment", "promptDigest", "assumptionDigest"], references: ["candidateIds", "visibleCandidateIds"], digestArrays: ["memoryDigests"], enums: { seedEnforcement: ["honored", "unverified"] } },
    paired_probe: { ids: ["pairId"], digests: ["obligationDigest", "evidenceDigest", "outcomeDigest"], enums: { axis: ["preference_wording", "initial_condition"], arm: ["baseline", "variant"] } },
    evaluator_boundary: { ids: ["builderId", "evaluatorId"], digests: ["sealedOracleDigest", "appliedOracleDigest"], booleans: ["untrustedOracleInput"] },
    assumption_check: { digests: ["sealedAssumptionsDigest", "appliedAssumptionsDigest"] },
    memory_validation: { digests: ["memoryDigest"], booleans: ["contaminated"], digestArrays: ["derivedFromDigests"] },
    terminal_claim: { ids: ["claimId"], references: ["evidenceIds"] },
  };
  const definition = typeof audit.kind === "string" && Object.hasOwn(fields, audit.kind) ? fields[audit.kind] : undefined;
  if (!definition) { problem(problems, `${path}.kind`, "invalid_enum", "unknown investigation audit kind"); return; }
  const keys = ["kind", ...(definition.ids ?? []), ...(definition.digests ?? []), ...(definition.references ?? []), ...(definition.digestArrays ?? []), ...(definition.booleans ?? []), ...Object.keys(definition.enums ?? {})];
  exactPayloadFields(audit, keys, [], problems, path);
  for (const key of definition.ids ?? []) boundedIdentifier(audit[key], `${path}.${key}`, problems);
  for (const key of definition.digests ?? []) if (!isSha256Digest(audit[key])) problem(problems, `${path}.${key}`, "invalid_digest", "audit digest must be SHA-256");
  for (const key of definition.references ?? []) identifierArray(audit[key], `${path}.${key}`, problems);
  for (const key of definition.digestArrays ?? []) digestArray(audit[key], `${path}.${key}`, problems);
  for (const key of definition.booleans ?? []) if (typeof audit[key] !== "boolean") problem(problems, `${path}.${key}`, "invalid_type", "audit flag must be boolean");
  for (const [key, choices] of Object.entries(definition.enums ?? {})) if (!choices.includes(audit[key] as string)) problem(problems, `${path}.${key}`, "invalid_enum", "unknown audit value");
}

function validatePayload(kind: EventKind, payload: Record<string, unknown>, problems: ProtocolProblem[]): void {
  const commonSummary = () => {
    boundedSummary(payload.summary, "$.payload.summary", problems);
  };
  switch (kind) {
    case "stage.status":
      exactPayloadFields(payload, ["stage", "status", "summary"], ["progress"], problems);
      if (!LIFECYCLE_STAGES.includes(payload.stage as never)) problem(problems, "$.payload.stage", "invalid_stage", "unknown lifecycle stage");
      if (!["entered", "working", "completed", "failed", "skipped"].includes(payload.status as string)) problem(problems, "$.payload.status", "invalid_status", "unknown stage status");
      if (payload.progress !== undefined && (typeof payload.progress !== "number" || payload.progress < 0 || payload.progress > 1)) problem(problems, "$.payload.progress", "invalid_progress", "progress must be between zero and one");
      commonSummary();
      break;
    case "claim.published":
      exactPayloadFields(payload, ["claimId", "statement", "claimType"], ["confidence", "candidateId"], problems);
      boundedIdentifier(payload.claimId, "$.payload.claimId", problems);
      if (!nonEmptyString(payload.statement)) problem(problems, "$.payload.statement", "invalid_claim", "statement must be a non-empty string");
      if (Object.hasOwn(payload, "candidateId")) boundedIdentifier(payload.candidateId, "$.payload.candidateId", problems);
      if (!["interpretation", "mechanism", "risk", "requirement", "prediction"].includes(payload.claimType as string)) problem(problems, "$.payload.claimType", "invalid_enum", "unknown claim type");
      if (payload.confidence !== undefined && (typeof payload.confidence !== "number" || payload.confidence < 0 || payload.confidence > 1)) problem(problems, "$.payload.confidence", "invalid_confidence", "confidence must be between zero and one");
      break;
    case "action.status": {
      exactPayloadFields(
        payload,
        ["actionId", "actionType", "status", "summary"],
        ["toolId", "artifactDigests", "resource"],
        problems,
      );
      boundedIdentifier(payload.actionId, "$.payload.actionId", problems);
      boundedIdentifier(payload.actionType, "$.payload.actionType", problems);
      if (!["requested", "started", "completed", "failed", "denied"].includes(payload.status as string)) {
        problem(problems, "$.payload.status", "invalid_status", "unknown action status");
      }
      if (Object.hasOwn(payload, "toolId")) boundedIdentifier(payload.toolId, "$.payload.toolId", problems);
      if (Object.hasOwn(payload, "artifactDigests")) {
        digestArray(payload.artifactDigests, "$.payload.artifactDigests", problems);
      }
      if (Object.hasOwn(payload, "resource")) {
        const resource = inertRecord(payload.resource, "$.payload.resource", problems);
        if (resource) {
          const fields = ["cpuMillis", "wallMillis", "bytesRead", "bytesWritten"] as const;
          rejectUnknownKeys(resource, new Set(fields), "$.payload.resource", problems);
          for (const field of fields) {
            if (Object.hasOwn(resource, field)
              && (!Number.isSafeInteger(resource[field]) || (resource[field] as number) < 0)) {
              problem(problems, `$.payload.resource.${field}`, "invalid_counter", `${field} must be a non-negative safe integer`);
            }
          }
        }
      }
      commonSummary();
      break;
    }
    case "evidence.observed": {
      exactPayloadFields(
        payload,
        ["evidenceId", "evidenceType", "summary", "contentDigest"],
        ["candidateId", "assayId", "supports", "refutes", "audit", "formalProof", "originalSubject"],
        problems,
      );
      boundedIdentifier(payload.evidenceId, "$.payload.evidenceId", problems);
      if (!EVIDENCE_TYPES.has(payload.evidenceType as string)) {
        problem(problems, "$.payload.evidenceType", "invalid_enum", "unknown evidence type");
      }
      if (!isSha256Digest(payload.contentDigest)) {
        problem(problems, "$.payload.contentDigest", "invalid_digest", "contentDigest must be a SHA-256 digest");
      }
      if (Object.hasOwn(payload, "candidateId")) boundedIdentifier(payload.candidateId, "$.payload.candidateId", problems);
      if (Object.hasOwn(payload, "assayId")) boundedIdentifier(payload.assayId, "$.payload.assayId", problems);
      if (Object.hasOwn(payload, "audit")) {
        validateInvestigationAudit(payload.audit, problems);
        if (payload.evidenceType !== "tool_observation") problem(problems, "$.payload.audit", "invalid_authority", "audit receipts require a runtime tool observation");
        if (digestJson(payload.audit as JsonValue) !== payload.contentDigest) problem(problems, "$.payload.contentDigest", "digest_mismatch", "audit receipt digest does not match its exact public content");
      }
      if (Object.hasOwn(payload, "formalProof")) {
        validateFormalCounterexample(payload.formalProof, problems);
        if (payload.evidenceType !== "tool_observation" || ["candidateId", "assayId", "supports", "refutes", "audit"].some((key) => Object.hasOwn(payload, key))) problem(problems, "$.payload.formalProof", "invalid_authority", "formal proof is a distinct global certificate, never a sandbox or model evidence edge");
        if (digestJson(payload.formalProof as JsonValue) !== payload.contentDigest) problem(problems, "$.payload.contentDigest", "digest_mismatch", "formal proof digest must match its exact certificate");
      }
      const supports = Object.hasOwn(payload, "supports")
        ? identifierArray(payload.supports, "$.payload.supports", problems)
        : undefined;
      const refutes = Object.hasOwn(payload, "refutes")
        ? identifierArray(payload.refutes, "$.payload.refutes", problems)
        : undefined;
      if (payload.evidenceType === "original_subject_assertions" || Object.hasOwn(payload, "originalSubject")) {
        const path = "$.payload.originalSubject", binding = inertRecord(payload.originalSubject, path, problems);
        if (payload.evidenceType !== "original_subject_assertions"
          || ["candidateId", "assayId", "audit", "formalProof"].some(key => Object.hasOwn(payload, key))) {
          problem(problems, path, "invalid_authority", "original-subject assertions require a distinct Bone event without candidate, assay, audit or formal authority");
        }
        if (binding) {
          exactPayloadFields(binding, ["protocol", "subjectId", "obligationId", "captureDigest", "certificateDigest", "executionReceiptDigest", "kernelDigest"], [], problems, path);
          if (binding.protocol !== "jevyr.original-subject-assertion-binding/1") problem(problems, `${path}.protocol`, "invalid_protocol", "unknown original-subject binding");
          for (const key of ["subjectId", "obligationId"]) boundedIdentifier(binding[key], `${path}.${key}`, problems);
          for (const key of ["captureDigest", "certificateDigest", "executionReceiptDigest", "kernelDigest"]) if (!isSha256Digest(binding[key])) problem(problems, `${path}.${key}`, "invalid_digest", "original-subject binding requires SHA-256");
          if (payload.contentDigest !== binding.certificateDigest) problem(problems, "$.payload.contentDigest", "digest_mismatch", "original-subject content must bind the certificate");
          const targets = [...(supports ?? []), ...(refutes ?? [])];
          if (targets.length !== 1 || targets[0] !== binding.obligationId) problem(problems, path, "invalid_authority", "original-subject evidence must claim exactly one bound support or refutation");
        }
      }
      if (supports && refutes) {
        const supported = new Set(supports);
        for (let index = 0; index < refutes.length; index += 1) {
          if (supported.has(refutes[index]!)) {
            problem(
              problems,
              `$.payload.refutes[${index}]`,
              "conflict",
              "an identifier cannot be both supported and refuted by one evidence observation",
            );
          }
        }
      }
      commonSummary();
      break;
    }
    case "candidate.status": {
      exactPayloadFields(
        payload,
        ["candidateId", "status", "summary"],
        ["feasibility", "parentIds", "artifactDigests"],
        problems,
      );
      const candidateIdIsValid = boundedIdentifier(payload.candidateId, "$.payload.candidateId", problems);
      if (!CANDIDATE_STATUSES.has(payload.status as string)) {
        problem(problems, "$.payload.status", "invalid_enum", "unknown candidate status");
      }
      if (Object.hasOwn(payload, "feasibility") && !CANDIDATE_FEASIBILITIES.has(payload.feasibility as string)) {
        problem(problems, "$.payload.feasibility", "invalid_enum", "unknown candidate feasibility");
      }
      const parents = Object.hasOwn(payload, "parentIds")
        ? identifierArray(payload.parentIds, "$.payload.parentIds", problems)
        : undefined;
      if (parents && candidateIdIsValid) {
        if (parents.includes(payload.candidateId as string)) {
          problem(problems, "$.payload.parentIds", "cycle", "a candidate cannot name itself as a parent");
        }
      }
      if (Object.hasOwn(payload, "artifactDigests")) {
        digestArray(payload.artifactDigests, "$.payload.artifactDigests", problems);
      }
      commonSummary();
      break;
    }
    case "assay.status":
      exactPayloadFields(
        payload,
        ["assayId", "status", "critical", "summary"],
        ["candidateId", "obligationId", "evidenceIds", "scope", "populationIds"],
        problems,
      );
      boundedIdentifier(payload.assayId, "$.payload.assayId", problems);
      if (!ASSAY_STATUSES.has(payload.status as string)) {
        problem(problems, "$.payload.status", "invalid_enum", "unknown assay status");
      }
      if (typeof payload.critical !== "boolean") {
        problem(problems, "$.payload.critical", "invalid_type", "critical must be a boolean");
      }
      if (Object.hasOwn(payload, "candidateId")) boundedIdentifier(payload.candidateId, "$.payload.candidateId", problems);
      if (Object.hasOwn(payload, "obligationId")) boundedIdentifier(payload.obligationId, "$.payload.obligationId", problems);
      if (Object.hasOwn(payload, "evidenceIds")) {
        identifierArray(payload.evidenceIds, "$.payload.evidenceIds", problems);
      }
      if (Object.hasOwn(payload, "scope") || Object.hasOwn(payload, "populationIds")) {
        const population = identifierArray(payload.populationIds, "$.payload.populationIds", problems);
        if (payload.scope !== "closed_population" || payload.critical !== true || payload.status !== "failed" || payload.candidateId !== undefined || payload.obligationId !== undefined || !population?.length || !Array.isArray(payload.evidenceIds) || payload.evidenceIds.length !== population.length) problem(problems, "$.payload.scope", "invalid_population_closure", "closed population failure requires one failed observation per member and no global obligation claim");
      }
      commonSummary();
      break;
    case "reflex.completed": {
      exactPayloadFields(payload, ["loop", "reviewedEvidenceDigest", "intentContractDigest", "challengedNodeIds", "materialFindings", "decision"], ["audits"], problems);
      if (![1, 2].includes(payload.loop as number)) problem(problems, "$.payload.loop", "invalid_loop", "Reflex loop must be one or two");
      if (!isSha256Digest(payload.reviewedEvidenceDigest)) problem(problems, "$.payload.reviewedEvidenceDigest", "invalid_digest", "reviewedEvidenceDigest must be a SHA-256 digest");
      if (!isSha256Digest(payload.intentContractDigest)) problem(problems, "$.payload.intentContractDigest", "invalid_digest", "intentContractDigest must be a SHA-256 digest");
      identifierArray(payload.challengedNodeIds, "$.payload.challengedNodeIds", problems);
      const findings = inertArray(payload.materialFindings, "$.payload.materialFindings", MAX_EVENT_REFERENCES, problems);
      findings?.forEach((entry, index) => {
        const path = `$.payload.materialFindings[${index}]`;
        const finding = inertRecord(entry, path, problems);
        if (!finding) return;
        exactPayloadFields(finding, ["code", "summary", "evidenceIds"], [], problems, path);
        boundedIdentifier(finding.code, `${path}.code`, problems);
        boundedSummary(finding.summary, `${path}.summary`, problems);
        identifierArray(finding.evidenceIds, `${path}.evidenceIds`, problems);
      });
      if (!["confirm", "revise", "repeat_once"].includes(payload.decision as string)) {
        problem(problems, "$.payload.decision", "invalid_decision", "unknown Reflex decision");
      }
      if (Object.hasOwn(payload, "audits")) inertArray(payload.audits, "$.payload.audits", 32, problems)?.forEach((entry, index) => {
        const path = `$.payload.audits[${index}]`;
        const audit = inertRecord(entry, path, problems);
        if (!audit) return;
        exactPayloadFields(audit, ["audit", "status", "summary", "evidenceIds"], [], problems, path);
        boundedIdentifier(audit.audit, `${path}.audit`, problems);
        boundedSummary(audit.summary, `${path}.summary`, problems);
        identifierArray(audit.evidenceIds, `${path}.evidenceIds`, problems);
        if (!["passed", "failed", "unmeasured"].includes(audit.status as string)) problem(problems, `${path}.status`, "invalid_enum", "unknown audit status");
      });
      break;
    }
    case "memory.influence":
      exactPayloadFields(payload, ["memoryDigest", "influence", "summary", "weight"], [], problems);
      if (!isSha256Digest(payload.memoryDigest)) problem(problems, "$.payload.memoryDigest", "invalid_digest", "memoryDigest must be a SHA-256 digest");
      if (!["seeded_hypothesis", "strategy_selected", "calibration_applied"].includes(payload.influence as string)) {
        problem(problems, "$.payload.influence", "invalid_influence", "unknown memory influence");
      }
      if (typeof payload.weight !== "number" || payload.weight < 0 || payload.weight > 0.2) problem(problems, "$.payload.weight", "invalid_weight", "memory weight must be between zero and 0.2");
      commonSummary();
      break;
    case "search.status": {
      exactPayloadFields(
        payload,
        ["layer", "status", "attempted", "attemptSafetyCeiling", "resources", "summary"],
        ["candidateId", "assayId", "hypothesisNursery", "assayArchive", "termination"],
        problems,
      );
      if (!["HYPOTHESIS_NURSERY", "ASSAY_ARCHIVE"].includes(payload.layer as string)) problem(problems, "$.payload.layer", "invalid_layer", "unknown search telemetry layer");
      if (!["started", "exploring", "hypothesis_admitted", "archive_changed", "completed", "failed"].includes(payload.status as string)) problem(problems, "$.payload.status", "invalid_status", "unknown search status");
      if (!Number.isSafeInteger(payload.attempted) || (payload.attempted as number) < 0) {
        problem(problems, "$.payload.attempted", "invalid_counter", "attempted must be a non-negative safe integer");
      }
      if (typeof payload.attemptSafetyCeiling !== "string" || payload.attemptSafetyCeiling.length > 128 || !/^[1-9][0-9]*$/u.test(payload.attemptSafetyCeiling)) problem(problems, "$.payload.attemptSafetyCeiling", "invalid_ceiling", "attemptSafetyCeiling must be a positive decimal string of at most 128 digits");
      if (Object.hasOwn(payload, "candidateId")) boundedIdentifier(payload.candidateId, "$.payload.candidateId", problems);
      if (Object.hasOwn(payload, "assayId")) boundedIdentifier(payload.assayId, "$.payload.assayId", problems);
      const resources = inertArray(payload.resources, "$.payload.resources", SEARCH_RESOURCE_NAMES.size, problems);
      if (!resources || resources.length !== SEARCH_RESOURCE_NAMES.size) {
        problem(problems, "$.payload.resources", "invalid_resources", `resources must contain all ${SEARCH_RESOURCE_NAMES.size} sealed resource dimensions`);
      } else {
        const names = new Set<string>();
        resources.forEach((entry, index) => {
          const path = `$.payload.resources[${index}]`;
          const resource = inertRecord(entry, path, problems);
          if (!resource) return;
          exactPayloadFields(resource, ["name", "used", "ceiling", "measurement"], [], problems, path);
          if (!SEARCH_RESOURCE_NAMES.has(resource.name as string) || names.has(resource.name as string)) problem(problems, `${path}.name`, "invalid_resource", "resource name must be known and unique");
          else names.add(resource.name as string);
          if (!Number.isSafeInteger(resource.ceiling) || (resource.ceiling as number) < 0) problem(problems, `${path}.ceiling`, "invalid_ceiling", "resource ceiling must be a non-negative safe integer");
          if (!["MEASURED", "UPPER_BOUND", "DECLARED_ONLY"].includes(resource.measurement as string)) problem(problems, `${path}.measurement`, "invalid_measurement", "unknown resource measurement status");
          if (resource.measurement === "DECLARED_ONLY") {
            if (resource.used !== null) problem(problems, `${path}.used`, "unmeasured_value", "declared-only resources must use null");
          } else if (typeof resource.used !== "number" || !Number.isFinite(resource.used) || resource.used < 0) {
            problem(problems, `${path}.used`, "invalid_usage", "measured usage must be a non-negative finite number");
          }
        });
      }
      const nursery = Object.hasOwn(payload, "hypothesisNursery")
        ? inertRecord(payload.hypothesisNursery, "$.payload.hypothesisNursery", problems)
        : undefined;
      if (payload.layer === "HYPOTHESIS_NURSERY" && !nursery) {
        problem(problems, "$.payload.hypothesisNursery", "required", "nursery telemetry is required for the hypothesis layer");
      }
      if (nursery) {
        exactPayloadFields(nursery, ["exactDistinctHypotheses", "scars", "declaredMechanismLabels", "exactYieldAge"], [], problems, "$.payload.hypothesisNursery");
        for (const field of ["exactDistinctHypotheses", "scars", "exactYieldAge"] as const) {
          if (!Number.isSafeInteger(nursery[field]) || (nursery[field] as number) < 0) problem(problems, `$.payload.hypothesisNursery.${field}`, "invalid_counter", `${field} must be a non-negative safe integer`);
        }
        const labels = inertArray(nursery.declaredMechanismLabels, "$.payload.hypothesisNursery.declaredMechanismLabels", MAX_EVENT_REFERENCES, problems);
        labels?.forEach((entry, index) => {
          if (!nonEmptyString(entry)) problem(problems, `$.payload.hypothesisNursery.declaredMechanismLabels[${index}]`, "invalid_string", "mechanism labels must be non-empty strings");
        });
      }
      const archive = Object.hasOwn(payload, "assayArchive")
        ? inertRecord(payload.assayArchive, "$.payload.assayArchive", problems)
        : undefined;
      if (payload.layer === "ASSAY_ARCHIVE" && !archive) {
        problem(problems, "$.payload.assayArchive", "required", "archive telemetry is required for the assay layer");
      }
      if (archive) {
        exactPayloadFields(archive, ["measuredEntries", "occupiedNiches"], ["lastMeasuredNovelty"], problems, "$.payload.assayArchive");
        for (const field of ["measuredEntries", "occupiedNiches"] as const) {
          if (!Number.isSafeInteger(archive[field]) || (archive[field] as number) < 0) problem(problems, `$.payload.assayArchive.${field}`, "invalid_counter", `${field} must be a non-negative safe integer`);
        }
        if (archive.lastMeasuredNovelty !== undefined && (typeof archive.lastMeasuredNovelty !== "number" || !Number.isFinite(archive.lastMeasuredNovelty) || archive.lastMeasuredNovelty < 0 || archive.lastMeasuredNovelty > 1)) problem(problems, "$.payload.assayArchive.lastMeasuredNovelty", "invalid_novelty", "measured novelty must be in [0, 1]");
      }
      if (payload.termination !== undefined && !["HYPOTHESIS_SATURATED", "RESOURCE_EXHAUSTED", "ATTEMPT_CEILING"].includes(payload.termination as string)) problem(problems, "$.payload.termination", "invalid_termination", "unknown search termination reason");
      commonSummary();
      break;
    }
    case "kernel.status":
      exactPayloadFields(payload, ["operation", "summary"], ["artifactDigest"], problems);
      if (!["sealed", "policy_compiled", "record_crystallized", "signed", "terminated"].includes(payload.operation as string)) {
        problem(problems, "$.payload.operation", "invalid_operation", "unknown kernel operation");
      }
      if (Object.hasOwn(payload, "artifactDigest") && !isSha256Digest(payload.artifactDigest)) {
        problem(problems, "$.payload.artifactDigest", "invalid_digest", "artifactDigest must be a SHA-256 digest");
      }
      commonSummary();
      break;
  }
}
