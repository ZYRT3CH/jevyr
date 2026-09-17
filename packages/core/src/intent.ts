import {
  INTENT_COMPILER_VERSION,
  INTENT_CONTRACT_PROTOCOL,
  digestJson,
  sha256Digest,
  type AlternativeInterpretation,
  type IntentAmbiguity,
  type IntentAssayability,
  type IntentConstraint,
  type IntentContract,
  type IntentGoal,
  type IntentObligation,
  type IntentOracle,
  type IntentOutcomeCondition,
  type IntentStatementOrigin,
  type JsonValue,
} from "@jevyr/protocol";
import type { Obligation, PolicyInput } from "./policy.js";

export { INTENT_COMPILER_VERSION, INTENT_CONTRACT_PROTOCOL } from "@jevyr/protocol";
export type {
  AlternativeInterpretation,
  IntentAmbiguity,
  IntentAssayability,
  IntentConstraint,
  IntentContract,
  IntentGoal,
  IntentObligation,
  IntentOracle,
  IntentOutcomeCondition,
  IntentStatementOrigin,
} from "@jevyr/protocol";

export interface IntentCompilerInput {
  /** Preserved byte-for-byte in the contract. */
  impulse: string;
  constraints?: readonly string[];
  requestedAssays?: readonly string[];
  subjectIds?: readonly string[];
}

type UnsignedIntentContract = Omit<IntentContract, "digest">;

const SUBJECTIVE_TERMS = [
  "absurd",
  "beautiful",
  "best",
  "better",
  "elegant",
  "extraordinary",
  "fast",
  "good",
  "high quality",
  "interesting",
  "intuitive",
  "robust",
  "simple",
  "smart",
  "user-friendly",
  "weird",
] as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function normalizeStatement(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function uniqueSorted(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map(normalizeStatement).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function stableId(prefix: string, value: JsonValue): string {
  return `${prefix}_${digestJson(value).slice("sha256:".length, "sha256:".length + 20)}`;
}

function contractJson(contract: UnsignedIntentContract): JsonValue {
  return contract as unknown as JsonValue;
}

function extractGoal(impulse: string): IntentGoal {
  const marker = /\b(?:success\s+(?:means|requires|is)|succeeds?\s+(?:if|when)|done\s+when|failure\s+(?:means|is|occurs\s+when)|fails?\s+(?:if|when))\b/iu.exec(impulse);
  if (marker?.index !== undefined && marker.index > 0) {
    const prefix = normalizeStatement(impulse.slice(0, marker.index).replace(/[;,.:\s]+$/u, ""));
    if (prefix) return { statement: prefix, source: "impulse_prefix" };
  }
  return { statement: normalizeStatement(impulse), source: "whole_impulse" };
}

function extractImpulseConstraints(impulse: string): readonly string[] {
  const expressions = [
    /\bwithout\s+[^,;.!?]+/giu,
    /\b(?:must|shall)\s+not\s+[^,;.!?]+/giu,
    /\b(?:do\s+not|don't)\s+[^,;.!?]+/giu,
    /\bnever\s+[^,;.!?]+/giu,
    /\bno\s+(?:internet|network|writes?|modifications?|changes?)\b[^,;.!?]*/giu,
    /\bonly\s+(?:use|read|write|modify|access|accept|emit|return|produce|allow|connect|communicate)\b[^,;.!?]*/giu,
  ];
  return uniqueSorted(expressions.flatMap((expression) => [...impulse.matchAll(expression)].map((match) => match[0] ?? "")));
}

function extractDeclaredConditions(impulse: string, kind: "success" | "failure" = "success"): readonly string[] {
  const expression = kind === "success"
    ? /\b(?:success\s+(?:means|requires|is)|succeeds?\s+(?:if|when)|done\s+when)\b/giu
    : /\b(?:failure\s+(?:means|is|occurs\s+when)|fails?\s+(?:if|when))\b/giu;
  // Preserve offsets while masking quoted operands. Dots in file names,
  // decimals, and URLs are not sentence boundaries; punctuation in quoted
  // commands/output must never silently weaken a sealed obligation.
  let quote: string | undefined;
  let escaped = false;
  const mask = impulse.split("").map((char, index) => {
    if (quote !== undefined) {
      if (!escaped && char === quote) quote = undefined;
      escaped = !escaped && char === "\\";
      return " ";
    }
    if (["`", "\"", "'"].includes(char) && !(char === "'" && /\w/u.test(impulse[index - 1] ?? "") && /\w/u.test(impulse[index + 1] ?? ""))) { quote = char; escaped = false; return " "; }
    return char;
  }).join("");
  return uniqueSorted([...mask.matchAll(expression)].map((match) => {
    let start = (match.index ?? 0) + match[0].length;
    // Consume spacing in the original string, never through a masked operand.
    start += /^\s*[:=-]?\s*/u.exec(impulse.slice(start))?.[0].length ?? 0;
    let end = start;
    while (end < impulse.length) {
      const char = mask[end];
      if (char === ";" || char !== undefined && /[.!?]/u.test(char) && (end + 1 === impulse.length || /\s/u.test(mask[end + 1] ?? ""))) break;
      end += 1;
    }
    return impulse.slice(start, end);
  }));
}

function inferOracle(statement: string, origin: IntentStatementOrigin): IntentOracle | undefined {
  const normalized = normalizeStatement(statement);
  const lower = normalized.toLocaleLowerCase("en-US");

  if (origin === "requested_assay") {
    return { kind: "requested_assay", operand: normalized, operator: "passes", expected: "pass" };
  }

  const command = /`([^`]+)`[^.;]*(?:exit(?:s|ed)?\s+(?:with\s+)?(?:code\s+)?0|pass(?:es|ed)?)/iu.exec(normalized);
  if (command?.[1]) {
    return { kind: "command_exit_code", operand: command[1], operator: "equals", expected: "0" };
  }

  const exactOutput = /\b(?:returns?|outputs?|emits?|produces?)\s+(?:exactly\s+)?(["'][^"']*["']|-?\d+(?:\.\d+)?|true|false|null)(?=$|[\s,;.!?])/iu.exec(normalized);
  if (exactOutput?.[1]) {
    return { kind: "exact_output", operand: "result", operator: "equals", expected: exactOutput[1] };
  }

  const path = /\b(?:file|directory|path)\s+(?:named\s+)?`([^`]+)`[^.;]*(?:exists?|is\s+created|is\s+present)|\b(?:create|produce)\s+(?:a\s+)?(?:file|directory)\s+(?:named\s+)?`([^`]+)`/iu.exec(normalized);
  const capturedPath = path?.[1] ?? path?.[2];
  if (capturedPath) {
    return { kind: "path_exists", operand: capturedPath, operator: "exists", expected: "true" };
  }

  if (/\bvalid\s+json\b/iu.test(lower) || /\bjson\s+(?:parses?|parseable)\b/iu.test(lower)) {
    return { kind: "output_parse", operand: "result", operator: "parses_as", expected: "application/json" };
  }
  if (/\b(?:offline|no\s+(?:internet|network)|without\s+(?:internet|network)|network\s+(?:denied|disabled))\b/iu.test(lower)) {
    return { kind: "network_access_count", operand: "forge", operator: "equals", expected: "0" };
  }
  if (/\b(?:read[- ]only|no\s+(?:file|filesystem|repository|source)\s+writes?|without\s+(?:writing|modifying|changing)|(?:do\s+not|must\s+not|never)\s+(?:write|modify|change|edit))\b/iu.test(lower)) {
    return { kind: "sealed_subject_digest", operand: "sealed_subjects", operator: "unchanged", expected: "sealed_snapshot" };
  }
  if (/\b(?:all\s+)?(?:sealed\s+|existing\s+)?tests?\s+(?:must\s+)?pass(?:es|ed)?\b|\bpass(?:es|ed)?\s+(?:all\s+)?(?:sealed\s+|existing\s+)?tests?\b/iu.test(lower)) {
    return { kind: "sealed_test_suite", operand: "sealed_subject_test_suite", operator: "passes", expected: "zero_failures" };
  }
  return undefined;
}

function obligation(statement: string, origin: IntentStatementOrigin): IntentObligation {
  const oracle = inferOracle(statement, origin);
  const assayability: IntentAssayability = oracle === undefined ? "UNASSAYABLE" : "ASSAYABLE";
  const unsigned = {
    statement,
    origin,
    critical: true as const,
    assayability,
    ...(oracle === undefined ? { unassayableReason: "No truth-conditional oracle is stated or mechanically derivable from the Cast." } : { oracle }),
  };
  return { id: stableId("obl", unsigned as unknown as JsonValue), ...unsigned };
}

function buildAmbiguities(impulse: string): { ambiguities: readonly IntentAmbiguity[]; alternatives: readonly AlternativeInterpretation[] } {
  const detected: Array<Omit<IntentAmbiguity, "id"> & { alternatives: readonly string[] }> = [];
  const deictic = /\b(this|that|it|these|those|here|current)\b/iu.exec(impulse);
  if (deictic?.[1]) {
    detected.push({
      code: "DEICTIC_REFERENCE",
      sourceText: deictic[1],
      summary: `The referent of “${deictic[1]}” is not selected by the deterministic compiler.`,
      alternatives: [
        `Resolve “${deictic[1]}” to the sealed subject set.`,
        `Resolve “${deictic[1]}” to the result or process being produced, where grammatically applicable.`,
      ],
    });
  }
  if (/\bor\b/iu.test(impulse)) {
    detected.push({
      code: "DISJUNCTION_SCOPE",
      sourceText: "or",
      summary: "The Cast does not state whether its disjunction is inclusive, exclusive, or a search over alternatives.",
      alternatives: ["Treat the disjunction as inclusive.", "Treat the disjunction as exclusive.", "Explore each disjunct as a separate candidate lineage."],
    });
  }
  const modal = /\b(can|could|might|maybe|should)\b/iu.exec(impulse);
  if (modal?.[1]) {
    detected.push({
      code: "MODAL_FORCE",
      sourceText: modal[1],
      summary: `The modal force of “${modal[1]}” is not explicit.`,
      alternatives: ["Treat the modal as a required outcome.", "Treat the modal as permission to explore without claiming completion."],
    });
  }
  const openScope = /\b(anything|everything|anywhere|always)\b/iu.exec(impulse);
  if (openScope?.[1]) {
    detected.push({
      code: "OPEN_SCOPE",
      sourceText: openScope[1],
      summary: `The quantified scope of “${openScope[1]}” is not bounded by the Cast.`,
      alternatives: ["Limit the quantifier to the sealed subjects.", "Read the quantifier literally and leave the universal claim unproven without exhaustive evidence."],
    });
  }
  const subjective = SUBJECTIVE_TERMS.find((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+")}\\b`, "iu").test(impulse));
  if (subjective) {
    detected.push({
      code: "SUBJECTIVE_PREDICATE",
      sourceText: subjective,
      summary: `The qualitative predicate “${subjective}” has no sealed comparator or measurement rule.`,
      alternatives: [
        `Keep “${subjective}” as a literal but unassayable requirement.`,
        `Treat “${subjective}” as satisfiable only if a sealed requested assay supplies an observable metric.`,
      ],
    });
  }

  detected.sort((a, b) => a.code.localeCompare(b.code) || a.sourceText.localeCompare(b.sourceText));
  const ambiguities: IntentAmbiguity[] = [];
  const alternatives: AlternativeInterpretation[] = [];
  for (const entry of detected) {
    const ambiguityId = stableId("amb", { code: entry.code, sourceText: entry.sourceText, summary: entry.summary });
    ambiguities.push({ id: ambiguityId, code: entry.code, sourceText: entry.sourceText, summary: entry.summary });
    for (const statement of entry.alternatives) {
      alternatives.push({
        id: stableId("alt", { ambiguityId, statement }),
        ambiguityId,
        statement,
        resolution: "UNRESOLVED",
      });
    }
  }
  alternatives.sort((a, b) => a.ambiguityId.localeCompare(b.ambiguityId) || a.id.localeCompare(b.id));
  return { ambiguities, alternatives };
}

function uniqueObligations(entries: readonly IntentObligation[]): readonly IntentObligation[] {
  const byMeaning = new Map<string, IntentObligation>();
  for (const entry of entries) {
    const key = `${entry.origin}\u0000${entry.statement.toLocaleLowerCase("en-US")}`;
    if (!byMeaning.has(key)) byMeaning.set(key, entry);
  }
  return [...byMeaning.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.statement.localeCompare(b.statement) || a.id.localeCompare(b.id));
}

export function recomputeIntentContractDigest(contract: Omit<IntentContract, "digest"> | IntentContract): string {
  const { digest: _ignored, ...unsigned } = contract as IntentContract;
  return digestJson(contractJson(unsigned));
}

export function assertIntentContract(contract: IntentContract): void {
  if (contract.protocol !== INTENT_CONTRACT_PROTOCOL) throw new TypeError(`Unsupported intent contract protocol ${contract.protocol as string}`);
  if (contract.compilerVersion !== INTENT_COMPILER_VERSION) throw new TypeError(`Unsupported intent compiler ${contract.compilerVersion as string}`);
  if (contract.originalImpulse.trim() === "") throw new TypeError("Intent contract impulse cannot be empty");
  if (sha256Digest(contract.originalImpulse) !== contract.originalImpulseDigest) throw new TypeError("Intent contract originalImpulseDigest mismatch");
  if (recomputeIntentContractDigest(contract) !== contract.digest) throw new TypeError("Intent contract digest mismatch");
  const ids = new Set<string>();
  for (const entry of [...contract.explicitConstraints, ...contract.successConditions, ...contract.failureConditions, ...contract.ambiguities, ...contract.alternativeInterpretations, ...contract.criticalObligations]) {
    if (!entry.id || ids.has(entry.id)) throw new TypeError(`Intent contract contains a missing or duplicate id: ${entry.id}`);
    ids.add(entry.id);
  }
  for (const entry of contract.criticalObligations) {
    if (entry.assayability === "ASSAYABLE" && entry.oracle === undefined) throw new TypeError(`Assayable obligation ${entry.id} lacks an oracle`);
    if (entry.assayability === "UNASSAYABLE" && entry.oracle !== undefined) throw new TypeError(`Unassayable obligation ${entry.id} unexpectedly has an oracle`);
  }
}

/**
 * Compiles the finite language Jevyr can prove without a model. It preserves
 * every unresolved meaning instead of selecting a helpful interpretation.
 */
export function compileIntentContract(input: IntentCompilerInput): IntentContract {
  if (typeof input.impulse !== "string" || input.impulse.trim() === "") throw new TypeError("Intent compiler requires a non-empty impulse");

  const goal = extractGoal(input.impulse);
  const declaredConstraints = uniqueSorted(input.constraints);
  const impulseConstraints = extractImpulseConstraints(input.impulse);
  const explicitConstraints = uniqueSorted([...declaredConstraints, ...impulseConstraints]).map((statement) => {
    const origin = declaredConstraints.includes(statement) ? "declared_constraint" as const : "impulse" as const;
    return { id: stableId("constraint", { origin, statement }), statement, origin };
  });
  const requestedAssays = uniqueSorted(input.requestedAssays);
  const subjectIds = uniqueSorted(input.subjectIds);
  const declaredSuccess = extractDeclaredConditions(input.impulse);
  const declaredFailure = extractDeclaredConditions(input.impulse, "failure");

  const criticalObligations = uniqueObligations([
    obligation(goal.statement, "impulse"),
    ...explicitConstraints.map((entry) => obligation(entry.statement, entry.origin)),
    ...declaredSuccess.map((statement) => obligation(statement, "impulse")),
    ...requestedAssays.map((statement) => obligation(statement, "requested_assay")),
  ]);
  const obligationIds = criticalObligations.map((entry) => entry.id);
  const successConditions: IntentOutcomeCondition[] = [
    {
      id: stableId("success", { code: "ALL_CRITICAL_OBLIGATIONS_PROVEN", obligationIds }),
      kind: "success",
      statement: "Every critical obligation has decisive admissible support from its sealed oracle, and none has decisive refutation.",
      source: "kernel",
      obligationIds,
    },
    ...declaredSuccess.map((statement) => ({
      id: stableId("success", { source: "impulse", statement }),
      kind: "success" as const,
      statement,
      source: "impulse" as const,
      obligationIds: criticalObligations.filter((entry) => entry.origin === "impulse" && entry.statement === statement).map((entry) => entry.id),
    })),
  ];
  const failureConditions: IntentOutcomeCondition[] = [
    {
      id: stableId("failure", { code: "CRITICAL_OBLIGATION_REFUTED", obligationIds }),
      kind: "failure",
      statement: "At least one critical obligation has decisive admissible refutation, or a critical assay fails.",
      source: "kernel",
      obligationIds,
    },
    ...declaredFailure.map((statement) => ({
      id: stableId("failure", { source: "impulse", statement }),
      kind: "failure" as const,
      statement,
      source: "impulse" as const,
      obligationIds: [],
    })),
  ];
  const { ambiguities, alternatives } = buildAmbiguities(input.impulse);

  const unsigned: UnsignedIntentContract = {
    protocol: INTENT_CONTRACT_PROTOCOL,
    compilerVersion: INTENT_COMPILER_VERSION,
    originalImpulse: input.impulse,
    originalImpulseDigest: sha256Digest(input.impulse),
    goal,
    subjectIds,
    explicitConstraints,
    requestedAssays,
    successConditions,
    failureConditions,
    ambiguities,
    alternativeInterpretations: alternatives,
    criticalObligations,
  };
  const contract: IntentContract = { ...unsigned, digest: digestJson(contractJson(unsigned)) };
  assertIntentContract(contract);
  return deepFreeze(structuredClone(contract));
}

export function obligationsFromIntentContract(contract: IntentContract): readonly Obligation[] {
  assertIntentContract(contract);
  return Object.freeze(contract.criticalObligations.map((entry) => Object.freeze({
    id: entry.id,
    statement: entry.statement,
    critical: true,
    assayability: entry.assayability === "ASSAYABLE" ? "assayable" as const : "unassayable" as const,
  })));
}

/** Bind a verified contract to the exact input consumed by the deterministic policy. */
export function bindIntentContract(
  input: Omit<PolicyInput, "intentContractDigest" | "obligations"> & { obligations?: readonly Obligation[] },
  contract: IntentContract,
): PolicyInput {
  const sealed = obligationsFromIntentContract(contract);
  const obligations = new Map(sealed.map((entry) => [entry.id, entry]));
  for (const entry of input.obligations ?? []) {
    const existing = obligations.get(entry.id);
    if (existing && (existing.statement !== entry.statement || existing.critical !== entry.critical || existing.assayability !== entry.assayability)) {
      throw new TypeError(`Obligation ${entry.id} conflicts with the sealed intent contract`);
    }
    obligations.set(entry.id, entry);
  }
  return {
    ...input,
    intentContractDigest: contract.digest,
    intentContract: contract,
    obligations: [...obligations.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
