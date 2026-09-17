import { readFileSync } from "node:fs";
import { digestJson, sha256Digest, type FormalCounterexampleCertificate, type IntentContract, type JsonValue } from "@jevyr/protocol";
import type { Obligation, PolicyInput } from "./policy.js";
import { assertIntentContract } from "./intent.js";

const NATURAL_GRAMMAR = /^(?:build|create|implement|design|provide) a (?:finite )?(?:lossless )?(?:encoder|mapping|function) that (maps every (?:possible )?finite (byte|bit) string to (?:a strictly shorter \2 string|a \2 string at least ([1-9][0-9]{0,5}) (bytes|bits) shorter))(?:, then (?:judge|assess|evaluate) the (?:original|unchanged|same) (?:request|goal)(?: rather than (?:silently )?substituting an easier one)?)?[.!]?$/iu;
const EXPLICIT_GRAMMAR = /^forall input in (ByteString|BitString)\(minLength=0\): len\(output\) <= len\(input\) - ([1-9][0-9]{0,5})$/u;
// Hash the actual module consumed by this process, not an editable parallel
// source copy. Packaged JavaScript and source execution have distinct seals.
export const FORMAL_COUNTEREXAMPLE_IMPLEMENTATION_DIGEST = sha256Digest(readFileSync(new URL(import.meta.url)));
export const FORMAL_COUNTEREXAMPLE_KERNEL = Object.freeze({
  protocol: "jevyr.formal-counterexample-kernel/1",
  rule: "finite-sequence-length-lower-bound",
  implementationDigest: FORMAL_COUNTEREXAMPLE_IMPLEMENTATION_DIGEST,
  naturalGrammar: NATURAL_GRAMMAR.source,
  naturalGrammarFlags: NATURAL_GRAMMAR.flags,
  explicitGrammar: EXPLICIT_GRAMMAR.source,
  explicitGrammarFlags: EXPLICIT_GRAMMAR.flags,
  maximumRequiredSaving: 999_999,
  domainWitness: "empty-sequence",
  proofCondition: "0-requiredSaving<minimumOutputLength=0",
  binding: "exact-sealed-obligation-statement-digest-and-source-span",
  producer: "kernel-only",
  context: "one-whole-impulse-obligation-no-subjects-constraints-or-requested-assays",
});
export const FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST = digestJson(FORMAL_COUNTEREXAMPLE_KERNEL);

function implementationIntact(): boolean {
  return sha256Digest(readFileSync(new URL(import.meta.url))) === FORMAL_COUNTEREXAMPLE_IMPLEMENTATION_DIGEST;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The checker must be named by the exact policy descriptor bound at Cast. */
export function formalProofKernelDigestFromPolicyDescriptor(descriptor: unknown): string | undefined {
  const policy = record(record(descriptor)?.policy);
  const selection = record(policy?.genomeSelection);
  const compilation = record(selection?.runtimeCompilation);
  const bone = record(compilation?.bone);
  const kernel = record(bone?.formalProofKernel);
  if (bone === undefined || kernel === undefined || compilation?.boneDigest !== digestJson(bone as JsonValue)
    || policy?.genomeSelectionDigest !== digestJson(selection as JsonValue)
    || kernel.protocol !== "jevyr.formal-counterexample-kernel/1"
    || kernel.descriptorDigest !== FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST
    || kernel.implementationDigest !== FORMAL_COUNTEREXAMPLE_IMPLEMENTATION_DIGEST
    || !implementationIntact()) return undefined;
  return FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST;
}

export function formalProofReplayOptions(descriptor: unknown): { formalProofKernelDigest?: string } {
  const digest = formalProofKernelDigestFromPolicyDescriptor(descriptor);
  return digest === undefined ? {} : { formalProofKernelDigest: digest };
}

function unqualifiedContext(contract: IntentContract): boolean {
  try { assertIntentContract(contract); } catch { return false; }
  return contract.goal.source === "whole_impulse" && contract.explicitConstraints.length === 0
    && contract.requestedAssays.length === 0 && contract.subjectIds.length === 0
    && contract.criticalObligations.length === 1 && contract.criticalObligations[0]?.statement === contract.goal.statement;
}

/** This is a deliberately closed controlled language, not a semantic LLM. */
function parseLengthRequirement(statement: string): Pick<FormalCounterexampleCertificate, "source" | "proposition"> | undefined {
  // The optional second clause is solely an instruction to judge the unchanged
  // request. Qualifications on the mapping itself are never discarded.
  const natural = NATURAL_GRAMMAR.exec(statement);
  const explicit = EXPLICIT_GRAMMAR.exec(statement);
  if (!natural && !explicit) return undefined;
  if (natural?.[4] !== undefined && natural[4].toLowerCase() !== `${natural[2]?.toLowerCase()}s`) return undefined;
  const text = natural?.[1] ?? explicit?.[0];
  if (text === undefined) return undefined;
  const requiredSaving = Number(natural ? natural[3] ?? "1" : explicit?.[2]);
  if (!Number.isSafeInteger(requiredSaving) || requiredSaving < 1 || requiredSaving > 999_999) return undefined;
  // A quantified finite sequence includes its empty member. Neither lossy
  // coding nor a different alphabet can create a negative-length output.
  const bytes = natural ? natural[2]?.toLowerCase() === "byte" : explicit?.[1] === "ByteString";
  return {
    source: { start: statement.indexOf(text), end: statement.indexOf(text) + text.length, text },
    proposition: { domain: bytes ? "all_finite_byte_strings" : "all_finite_bit_strings", minimumInputLength: 0, minimumOutputLength: 0, requiredSaving },
  };
}

function constructFormalCounterexample(
  intentContractDigest: string,
  obligation: Pick<Obligation, "id" | "statement" | "critical">,
): FormalCounterexampleCertificate | undefined {
  if (!obligation.critical) return undefined;
  const requirement = parseLengthRequirement(obligation.statement);
  if (!requirement) return undefined;
  return {
    protocol: "jevyr.formal-counterexample/1",
    rule: "finite-sequence-length-lower-bound",
    intentContractDigest,
    obligationId: obligation.id,
    statementDigest: sha256Digest(obligation.statement),
    ...requirement,
    witness: { inputLength: 0, inputHex: "", maximumOutputLength: -requirement.proposition.requiredSaving },
  };
}

export function constructFormalCounterexamples(contract: IntentContract): readonly FormalCounterexampleCertificate[] {
  if (!implementationIntact()) throw new Error("Formal counterexample implementation changed after startup");
  if (!unqualifiedContext(contract)) return [];
  return contract.criticalObligations.flatMap((obligation) => {
    const proof = constructFormalCounterexample(contract.digest, obligation);
    return proof === undefined ? [] : [proof];
  });
}

/** Reparse the exact sealed statement, then check the finite arithmetic witness. */
export function verifyFormalCounterexample(
  certificate: FormalCounterexampleCertificate,
  contract: IntentContract,
): boolean {
  if (!implementationIntact() || !unqualifiedContext(contract)) return false;
  const obligation = contract.criticalObligations.find((entry) => entry.id === certificate.obligationId);
  if (obligation === undefined) return false;
  const expected = constructFormalCounterexample(contract.digest, obligation);
  if (expected === undefined) return false;
  try {
    if (digestJson(certificate as unknown as JsonValue) !== digestJson(expected as unknown as JsonValue)) return false;
    const { proposition, witness } = certificate;
    return witness.inputLength >= proposition.minimumInputLength
      && witness.inputHex.length === witness.inputLength * 2
      && witness.maximumOutputLength === witness.inputLength - proposition.requiredSaving
      && witness.maximumOutputLength < proposition.minimumOutputLength;
  } catch { return false; }
}

export function assessFormalCounterexamples(input: Pick<PolicyInput, "intentContractDigest" | "intentContract" | "formalProofKernelDigest" | "obligations" | "auditEvents">): {
  readonly verified: readonly { obligationId: string; evidenceId: string; certificate: FormalCounterexampleCertificate }[];
  readonly rejectedEvidenceIds: readonly string[];
} {
  const verified: { obligationId: string; evidenceId: string; certificate: FormalCounterexampleCertificate }[] = [];
  const rejectedEvidenceIds: string[] = [];
  for (const event of input.auditEvents ?? []) {
    if (event.kind !== "evidence.observed" || event.payload.formalProof === undefined) continue;
    const certificate = event.payload.formalProof;
    const obligation = input.obligations.find((entry) => entry.id === certificate.obligationId);
    if (event.actor.kind !== "kernel" || event.actor.id !== "jevyr.bone" || event.stage !== "assay"
      || event.payload.evidenceType !== "tool_observation" || event.payload.supports !== undefined || event.payload.refutes !== undefined
      || digestJson(certificate as unknown as JsonValue) !== event.payload.contentDigest
      || input.formalProofKernelDigest !== FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST
      || input.intentContract === undefined || input.intentContract.digest !== input.intentContractDigest
      || obligation === undefined || input.obligations.length !== 1
      || obligation.statement !== input.intentContract.criticalObligations[0]?.statement
      || !verifyFormalCounterexample(certificate, input.intentContract)) {
      rejectedEvidenceIds.push(event.payload.evidenceId);
    } else verified.push({ obligationId: obligation.id, evidenceId: event.payload.evidenceId, certificate });
  }
  return { verified, rejectedEvidenceIds: rejectedEvidenceIds.sort() };
}
