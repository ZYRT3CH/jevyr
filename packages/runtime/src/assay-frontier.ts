import { isProxy } from "node:util/types";
import {
  canonicalize,
  digestJson,
  isSha256Digest,
  type JsonValue,
  type SearchResourceEnvelope,
} from "@jevyr/protocol";
import type { RequestedAssayPlan, SealedTestSuitePlan } from "./typed-oracles.js";

export const ASSAY_FRONTIER_PROTOCOL = "jevyr.assay-frontier/1" as const;
export const MAX_ASSAYS_PER_FRONTIER = 256;
export const ASSAY_ARCHIVE_V1 = Object.freeze({
  binsPerDimension: 5,
  elitesPerNiche: 2,
  minimumNovelty: 0,
  capacity: 4_096,
});

export interface AssayArchivePolicy {
  readonly binsPerDimension: number;
  readonly elitesPerNiche: number;
  readonly minimumNovelty: number;
  readonly capacity: number;
}

export interface AssayArchiveGenomeKnobs {
  readonly minimumNovelty: number;
  readonly capacity: number;
}

export interface ForgePlan {
  readonly tool: "forge.command";
  readonly args: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly obligationId?: string;
  readonly sealedSubjectDigest?: string;
  readonly sealedTestSuite?: SealedTestSuitePlan;
  readonly requestedAssay?: RequestedAssayPlan;
}

export interface SealedAssayPlan extends ForgePlan {
  readonly assayId: string;
  /** Deterministic operator-declared charge against maxTotalAssayCost. */
  readonly costUnits: number;
}

export interface AssayAggregateLimits {
  readonly maxForgeWallMillis: number;
  readonly maxForgeCpuMillis: number;
  readonly maxTotalAssayCost: number;
  readonly maxWritableBytes: number;
  readonly maxWritableInodes: number;
  readonly maxArtifactBytes: number;
}

export interface AssayFrontier {
  readonly protocol: typeof ASSAY_FRONTIER_PROTOCOL;
  readonly assays: readonly SealedAssayPlan[];
  readonly aggregateLimits: AssayAggregateLimits;
  readonly archive: AssayArchivePolicy;
  readonly digest: string;
}

/**
 * Take a side-effect-free snapshot of a policy object. Reading policy through
 * ordinary property access would let an accessor change what is validated
 * between reads. Only ordinary records (including null-prototype records) with
 * enumerable own data properties cross this boundary.
 */
function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  if (isProxy(value)) {
    throw new TypeError(`${path} must not be a Proxy`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain or null-prototype object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} must not contain symbol keys`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable) {
      throw new TypeError(`${path}.${key} must be an enumerable own data property`);
    }
    if (!("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must not be an accessor property`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function array(value: unknown, path: string, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${path} must be an ordinary array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || lengthDescriptor.enumerable || !Number.isSafeInteger(lengthDescriptor.value)
    || (lengthDescriptor.value as number) < 0 || (lengthDescriptor.value as number) > maximumLength) {
    throw new TypeError(`${path} must be an array of at most ${maximumLength} entries`);
  }
  const length = lengthDescriptor.value as number;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} must not contain symbol keys`);
    }
    if (key === "length") continue;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an enumerable own data property`);
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
      throw new TypeError(`${path}.${key} is not an array entry`);
    }
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path} must not contain holes or accessor entries`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], required: readonly string[], path: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new TypeError(`${path}.${key} is not a recognized assay field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
  }
}

function digestObject(value: unknown, path: string, fields: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, path);
  exactKeys(input, fields, fields, path);
  const output: Record<string, string> = {};
  for (const field of fields) {
    if (typeof input[field] !== "string" || !isSha256Digest(input[field] as string)) {
      throw new TypeError(`${path}.${field} must be a SHA-256 digest`);
    }
    output[field] = input[field] as string;
  }
  return Object.freeze(output);
}

function canonicalArgs(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const input = record(value, path);
  // The runtime owns source roots, and public policy descriptors must not carry
  // environment secrets. V1 therefore seals only finite argv.
  exactKeys(input, ["command", "args"], ["command"], path);
  if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 4_096 || input.command.includes("\0")) {
    throw new TypeError(`${path}.command must be a non-empty bounded string`);
  }
  const argv = input.args === undefined ? Object.freeze([]) : array(input.args, `${path}.args`, 1_024);
  for (const entry of argv) {
    if (typeof entry !== "string" || entry.length > 65_536 || entry.includes("\0")) {
      throw new TypeError(`${path}.args must contain at most 1024 bounded strings`);
    }
  }
  return Object.freeze({
    command: input.command,
    args: Object.freeze([...argv] as string[]),
  });
}

function canonicalPlan(value: unknown, index: number): SealedAssayPlan {
  const path = `assays[${index}]`;
  const input = record(value, path);
  exactKeys(
    input,
    [
      "assayId",
      "costUnits",
      "tool",
      "args",
      "timeoutMs",
      "obligationId",
      "sealedSubjectDigest",
      "sealedTestSuite",
      "requestedAssay",
    ],
    ["assayId", "costUnits", "tool", "args"],
    path,
  );
  if (typeof input.assayId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.assayId)) {
    throw new TypeError(`${path}.assayId contains unsupported characters`);
  }
  if (!Number.isSafeInteger(input.costUnits) || (input.costUnits as number) < 1) {
    throw new TypeError(`${path}.costUnits must be a positive safe integer`);
  }
  if (input.tool !== "forge.command") throw new TypeError(`${path}.tool must equal forge.command`);
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || (input.timeoutMs as number) < 1_000 || (input.timeoutMs as number) > 600_000)) {
    throw new TypeError(`${path}.timeoutMs must be a safe integer between 1000 and 600000`);
  }
  if (input.obligationId !== undefined && (typeof input.obligationId !== "string" || !/^obl_[a-f0-9]{20}$/u.test(input.obligationId))) {
    throw new TypeError(`${path}.obligationId must be a deterministic sealed obligation id`);
  }
  if (input.sealedSubjectDigest !== undefined && (typeof input.sealedSubjectDigest !== "string" || !isSha256Digest(input.sealedSubjectDigest))) {
    throw new TypeError(`${path}.sealedSubjectDigest must be a SHA-256 digest`);
  }
  const sealedTestSuite = digestObject(input.sealedTestSuite, `${path}.sealedTestSuite`, ["suiteDigest"]);
  const requestedAssay = digestObject(
    input.requestedAssay,
    `${path}.requestedAssay`,
    ["definitionDigest", "evaluatorDigest"],
  );
  return Object.freeze({
    assayId: input.assayId,
    costUnits: input.costUnits as number,
    tool: "forge.command",
    args: canonicalArgs(input.args, `${path}.args`),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs as number }),
    ...(input.obligationId === undefined ? {} : { obligationId: input.obligationId }),
    ...(input.sealedSubjectDigest === undefined ? {} : { sealedSubjectDigest: input.sealedSubjectDigest }),
    ...(sealedTestSuite === undefined
      ? {}
      : { sealedTestSuite: Object.freeze({ suiteDigest: sealedTestSuite.suiteDigest as string }) }),
    ...(requestedAssay === undefined
      ? {}
      : {
          requestedAssay: Object.freeze({
            definitionDigest: requestedAssay.definitionDigest as string,
            evaluatorDigest: requestedAssay.evaluatorDigest as string,
          }),
        }),
  });
}

function aggregateLimits(resources: SearchResourceEnvelope): AssayAggregateLimits {
  const input = record(resources, "resources");
  for (const field of [
    "maxForgeWallMillis",
    "maxForgeCpuMillis",
    "maxTotalAssayCost",
    "maxWritableBytes",
    "maxWritableInodes",
    "maxArtifactBytes",
  ] as const) {
    if (!Number.isSafeInteger(input[field]) || (input[field] as number) < 0) {
      throw new TypeError(`resources.${field} must be a nonnegative safe integer`);
    }
  }
  return Object.freeze({
    maxForgeWallMillis: input.maxForgeWallMillis as number,
    maxForgeCpuMillis: input.maxForgeCpuMillis as number,
    maxTotalAssayCost: input.maxTotalAssayCost as number,
    maxWritableBytes: input.maxWritableBytes as number,
    maxWritableInodes: input.maxWritableInodes as number,
    maxArtifactBytes: input.maxArtifactBytes as number,
  });
}

/** Compiles the complete finite assay set against the exact pre-Cast resource envelope. */
export function compileAssayFrontier(
  assaysValue: readonly unknown[],
  resources: SearchResourceEnvelope,
  archiveKnobs?: AssayArchiveGenomeKnobs,
): AssayFrontier {
  const assayInputs = array(assaysValue, "assays", MAX_ASSAYS_PER_FRONTIER);
  const assays: SealedAssayPlan[] = [];
  for (let index = 0; index < assayInputs.length; index += 1) {
    assays.push(canonicalPlan(assayInputs[index], index));
  }
  assays.sort((left, right) => left.assayId < right.assayId ? -1 : left.assayId > right.assayId ? 1 : 0);
  if (new Set(assays.map((entry) => entry.assayId)).size !== assays.length) {
    throw new TypeError("assay ids must be unique");
  }
  const limits = aggregateLimits(resources);
  const knobs = archiveKnobs === undefined ? undefined : record(archiveKnobs, "archive");
  if (knobs !== undefined) {
    exactKeys(knobs, ["minimumNovelty", "capacity"], ["minimumNovelty", "capacity"], "archive");
  }
  const minimumNoveltyValue = knobs?.minimumNovelty ?? ASSAY_ARCHIVE_V1.minimumNovelty;
  const capacityValue = knobs?.capacity ?? ASSAY_ARCHIVE_V1.capacity;
  if (typeof minimumNoveltyValue !== "number" || !Number.isFinite(minimumNoveltyValue)
    || minimumNoveltyValue < 0 || minimumNoveltyValue > 1) {
    throw new TypeError("archive.minimumNovelty must be a finite number in [0, 1]");
  }
  if (typeof capacityValue !== "number" || !Number.isSafeInteger(capacityValue)
    || capacityValue < 1 || capacityValue > 4_096) {
    throw new TypeError("archive.capacity must be a safe integer between 1 and 4096");
  }
  const minimumNovelty = minimumNoveltyValue;
  const capacity = capacityValue;
  const archive: AssayArchivePolicy = Object.freeze({
    binsPerDimension: ASSAY_ARCHIVE_V1.binsPerDimension,
    elitesPerNiche: ASSAY_ARCHIVE_V1.elitesPerNiche,
    minimumNovelty,
    capacity,
  });
  const payload = Object.freeze({
    protocol: ASSAY_FRONTIER_PROTOCOL,
    assays: Object.freeze(assays),
    aggregateLimits: limits,
    archive,
  });
  return Object.freeze({
    ...payload,
    digest: digestJson(payload as unknown as JsonValue),
  });
}

export function verifyAssayFrontier(value: AssayFrontier, resources: SearchResourceEnvelope): AssayFrontier {
  const input = record(value, "frontier");
  exactKeys(input, ["protocol", "assays", "aggregateLimits", "archive", "digest"], ["protocol", "assays", "aggregateLimits", "archive", "digest"], "frontier");
  if (input.protocol !== ASSAY_FRONTIER_PROTOCOL || typeof input.digest !== "string" || !isSha256Digest(input.digest)) {
    throw new TypeError("Assay frontier protocol or digest is invalid");
  }
  const archiveInput = record(input.archive, "frontier.archive");
  exactKeys(
    archiveInput,
    ["binsPerDimension", "elitesPerNiche", "minimumNovelty", "capacity"],
    ["binsPerDimension", "elitesPerNiche", "minimumNovelty", "capacity"],
    "frontier.archive",
  );
  const limitsInput = record(input.aggregateLimits, "frontier.aggregateLimits");
  const limitFields = [
    "maxForgeWallMillis",
    "maxForgeCpuMillis",
    "maxTotalAssayCost",
    "maxWritableBytes",
    "maxWritableInodes",
    "maxArtifactBytes",
  ] as const;
  exactKeys(limitsInput, limitFields, limitFields, "frontier.aggregateLimits");
  const submittedLimits = aggregateLimits(limitsInput as unknown as SearchResourceEnvelope);
  const assayInputs = array(input.assays, "frontier.assays", MAX_ASSAYS_PER_FRONTIER);
  const submittedAssays: SealedAssayPlan[] = [];
  for (let index = 0; index < assayInputs.length; index += 1) {
    submittedAssays.push(canonicalPlan(assayInputs[index], index));
  }
  const compiled = compileAssayFrontier(assayInputs, resources, {
    minimumNovelty: archiveInput.minimumNovelty as number,
    capacity: archiveInput.capacity as number,
  });
  const submitted = Object.freeze({
    protocol: input.protocol,
    assays: Object.freeze(submittedAssays),
    aggregateLimits: submittedLimits,
    archive: Object.freeze({
      binsPerDimension: archiveInput.binsPerDimension,
      elitesPerNiche: archiveInput.elitesPerNiche,
      minimumNovelty: archiveInput.minimumNovelty,
      capacity: archiveInput.capacity,
    }),
    digest: input.digest,
  });
  if (canonicalize(compiled as unknown as JsonValue) !== canonicalize(submitted as unknown as JsonValue)) {
    throw new TypeError("Assay frontier is not the canonical set bound to the sealed aggregate limits");
  }
  return compiled;
}
