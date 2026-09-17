import {
  digestJson,
  isSha256Digest,
  type CreationOutcome,
  type EmbodimentOutcome,
  type Feasibility,
  type IntegrityOutcome,
  type JsonValue,
  type JudgmentOutcome,
} from "@jevyr/protocol";
import type { MemoryCandidate } from "./types.js";

export const MEMORY_REPRODUCIBILITY_PROTOCOL = "jevyr.memory-reproducibility/1" as const;

export interface MemoryReproducibilityFingerprint {
  readonly protocol: typeof MEMORY_REPRODUCIBILITY_PROTOCOL;
  readonly origin: {
    readonly caseDigest: string;
    readonly runDigest: string;
  };
  readonly task: {
    readonly intentContractDigest: string;
    readonly subjectMaterialCaptureDigest: string;
  };
  readonly mechanism: {
    readonly policyDigest: string;
    readonly genomeDigest: string;
    /**
     * Digest of SearchEnvelope `{ protocol, profile }`. The concrete per-run
     * seed is derived later from runDigest and is deliberately not included.
     */
    readonly searchProfileDigest: string;
    readonly assayFrontierDigest: string | null;
  };
  readonly outcome: {
    readonly integrity: IntegrityOutcome;
    readonly creation: CreationOutcome;
    readonly embodiment: EmbodimentOutcome;
    readonly judgment: JudgmentOutcome;
    /** Case-local candidate ids are excluded; multiplicity remains observable. */
    readonly feasibilityProfile: readonly Feasibility[];
    readonly selectedFeasibility: Feasibility | null;
    /** Sorted with multiplicity. Evidence ids and prose are Case-local. */
    readonly basisCodes: readonly string[];
  };
}

const INTEGRITY = new Set<IntegrityOutcome>(["VALID", "INVALID"]);
const CREATION = new Set<CreationOutcome>(["CONCEIVED", "NO_SURVIVOR", "FAILED"]);
const EMBODIMENT = new Set<EmbodimentOutcome>(["BUILT", "NOT_BUILT", "FAILED"]);
const JUDGMENT = new Set<JudgmentOutcome>(["ACCEPT", "REJECT", "UNPROVEN", "NOT_APPLICABLE"]);
const FEASIBILITY = new Set<Feasibility>([
  "BUILDABLE_NOW",
  "BRIDGEABLE",
  "LAWFUL_BUT_OPEN",
  "CONTRADICTED",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    throw new TypeError(`${label} cannot contain symbol fields.`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new TypeError(`${label} cannot contain accessors.`);
  }
  const actual = Object.getOwnPropertyNames(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} contains unknown or missing fields.`);
  }
}

function sorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] as string) <= value);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (!isSha256Digest(value)) throw new TypeError(`${label} must be a SHA-256 digest.`);
}

/** Validate the exact, deliberately narrow, non-semantic comparison contract. */
export function assertMemoryReproducibilityFingerprint(
  value: unknown,
): asserts value is MemoryReproducibilityFingerprint {
  if (!record(value)) throw new TypeError("Memory reproducibility fingerprint must be a plain object.");
  exactKeys(value, ["protocol", "origin", "task", "mechanism", "outcome"], "Memory reproducibility fingerprint");
  if (value.protocol !== MEMORY_REPRODUCIBILITY_PROTOCOL) {
    throw new TypeError("Unsupported memory reproducibility protocol.");
  }
  if (!record(value.origin)) throw new TypeError("Memory reproducibility origin is malformed.");
  exactKeys(value.origin, ["caseDigest", "runDigest"], "Memory reproducibility origin");
  assertDigest(value.origin.caseDigest, "origin.caseDigest");
  assertDigest(value.origin.runDigest, "origin.runDigest");

  if (!record(value.task)) throw new TypeError("Memory reproducibility task is malformed.");
  exactKeys(value.task, ["intentContractDigest", "subjectMaterialCaptureDigest"], "Memory reproducibility task");
  assertDigest(value.task.intentContractDigest, "task.intentContractDigest");
  assertDigest(value.task.subjectMaterialCaptureDigest, "task.subjectMaterialCaptureDigest");

  if (!record(value.mechanism)) throw new TypeError("Memory reproducibility mechanism is malformed.");
  exactKeys(
    value.mechanism,
    ["policyDigest", "genomeDigest", "searchProfileDigest", "assayFrontierDigest"],
    "Memory reproducibility mechanism",
  );
  assertDigest(value.mechanism.policyDigest, "mechanism.policyDigest");
  assertDigest(value.mechanism.genomeDigest, "mechanism.genomeDigest");
  assertDigest(value.mechanism.searchProfileDigest, "mechanism.searchProfileDigest");
  if (value.mechanism.assayFrontierDigest !== null) {
    assertDigest(value.mechanism.assayFrontierDigest, "mechanism.assayFrontierDigest");
  }

  if (!record(value.outcome)) throw new TypeError("Memory reproducibility outcome is malformed.");
  exactKeys(
    value.outcome,
    [
      "integrity",
      "creation",
      "embodiment",
      "judgment",
      "feasibilityProfile",
      "selectedFeasibility",
      "basisCodes",
    ],
    "Memory reproducibility outcome",
  );
  if (typeof value.outcome.integrity !== "string" || !INTEGRITY.has(value.outcome.integrity as IntegrityOutcome)) {
    throw new TypeError("Memory reproducibility integrity outcome is invalid.");
  }
  if (typeof value.outcome.creation !== "string" || !CREATION.has(value.outcome.creation as CreationOutcome)) {
    throw new TypeError("Memory reproducibility creation outcome is invalid.");
  }
  if (typeof value.outcome.embodiment !== "string" || !EMBODIMENT.has(value.outcome.embodiment as EmbodimentOutcome)) {
    throw new TypeError("Memory reproducibility embodiment outcome is invalid.");
  }
  if (typeof value.outcome.judgment !== "string" || !JUDGMENT.has(value.outcome.judgment as JudgmentOutcome)) {
    throw new TypeError("Memory reproducibility judgment outcome is invalid.");
  }
  if (
    !Array.isArray(value.outcome.feasibilityProfile)
    || value.outcome.feasibilityProfile.length > 4_096
    || !value.outcome.feasibilityProfile.every(
      (entry): entry is Feasibility => typeof entry === "string" && FEASIBILITY.has(entry as Feasibility),
    )
    || !sorted(value.outcome.feasibilityProfile)
  ) {
    throw new TypeError("Memory reproducibility feasibility profile must be a bounded sorted feasibility array.");
  }
  if (
    value.outcome.selectedFeasibility !== null
    && (typeof value.outcome.selectedFeasibility !== "string"
      || !FEASIBILITY.has(value.outcome.selectedFeasibility as Feasibility))
  ) {
    throw new TypeError("Memory reproducibility selected feasibility is invalid.");
  }
  if (
    !Array.isArray(value.outcome.basisCodes)
    || value.outcome.basisCodes.length > 4_096
    || !value.outcome.basisCodes.every(
      (entry): entry is string => typeof entry === "string" && entry.length >= 1 && entry.length <= 256,
    )
    || !sorted(value.outcome.basisCodes)
  ) {
    throw new TypeError("Memory reproducibility basis codes must be a bounded sorted string array.");
  }
}

/**
 * Return no fingerprint for legacy/manual memory. If the reserved field is
 * present, malformed data fails closed rather than becoming broadly visible.
 */
export function memoryReproducibilityFingerprint(
  candidate: MemoryCandidate,
): MemoryReproducibilityFingerprint | undefined {
  const content = candidate.content;
  if (!record(content) || !("reproducibility" in content)) return undefined;
  const value = content.reproducibility;
  assertMemoryReproducibilityFingerprint(value);
  return structuredClone(value);
}

export function memoryReproducibilityFingerprintDigest(
  fingerprint: MemoryReproducibilityFingerprint,
): string {
  assertMemoryReproducibilityFingerprint(fingerprint);
  return digestJson(fingerprint as unknown as JsonValue);
}
