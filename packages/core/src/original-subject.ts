import { readFileSync } from "node:fs";
import { canonicalize, digestJson, sha256Digest, validateSealedCase, type JsonValue, type SealedCase } from "@jevyr/protocol";
import { compileIntentContract, obligationsFromIntentContract } from "./intent.js";
import type { AssayAssessment, PolicyInput } from "./policy.js";
import { REGO_POLICY_V2_SOURCE_DIGEST, REGO_POLICY_V2_WASM_DIGEST } from "./policy-v2-identity.js";

export const ORIGINAL_SUBJECT_POLICY_VERSION = "jevyr.bone/2" as const;
export const ORIGINAL_SUBJECT_ASSERTION_IMPLEMENTATION_DIGEST = sha256Digest(readFileSync(new URL(import.meta.url)));
export const ORIGINAL_SUBJECT_ASSERTION_KERNEL = Object.freeze({
  protocol: "jevyr.original-subject-assertion-kernel/1",
  implementationDigest: ORIGINAL_SUBJECT_ASSERTION_IMPLEMENTATION_DIGEST,
  policyVersion: ORIGINAL_SUBJECT_POLICY_VERSION,
  impulse: "Existing tests must pass.",
  context: "one-directory-one-critical-obligation-no-constraints-or-requested-assays",
  authority: "independently-replayed-original-capture-certificate-and-execution",
  edgeAdmission: "separate-exact-event-evidence-content-target-kind-allowlist",
  creationPrerequisite: "waived-only-for-exact-original-subject-purpose",
  judgmentScope: "original-certificate-edges-only; candidate-assays-and-selection-contradictions-remain-candidate-assessments",
  multipleSelections: "global-coherence-unproven; never-original-subject-refutation",
});
export const ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST = digestJson(ORIGINAL_SUBJECT_ASSERTION_KERNEL);
export interface OriginalSubjectContext {
  /** Authentication is performed by the verifier host before calling core. */
  readonly sealedCase: SealedCase;
  readonly kernelDigest: string;
}
/** Closed-population rows can omit candidateId but still assess only candidates. */
export function isCandidateScopedAssay(assay: AssayAssessment): boolean { return assay.candidateId !== undefined || assay.scope === "closed_population"; }
const same = (a: unknown, b: unknown) => canonicalize(a as JsonValue) === canonicalize(b as JsonValue);
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function intact(): boolean { return sha256Digest(readFileSync(new URL(import.meta.url))) === ORIGINAL_SUBJECT_ASSERTION_IMPLEMENTATION_DIGEST; }

/** The full original Case is checked, not a caller's assayability or purpose flag. */
export function originalSubjectPurpose(input: Pick<PolicyInput, "policyVersion" | "originalSubjectContext" | "intentContract" | "intentContractDigest" | "obligations">): Readonly<{ subjectId: string; obligationId: string; captureDigest: string; caseDigest: string; runDigest: string }> | undefined {
  try {
    const context = input.originalSubjectContext;
    if (input.policyVersion !== ORIGINAL_SUBJECT_POLICY_VERSION || !context || context.kernelDigest !== ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST
      || !same(Object.keys(context).sort(), ["kernelDigest", "sealedCase"]) || !intact()) return undefined;
    const checked = validateSealedCase(context.sealedCase);
    if (!checked.ok || !checked.value) return undefined;
    const sealed = checked.value, subject = sealed.subjects[0], declaration = sealed.intent.subjects[0];
    if (sealed.policyVersion !== ORIGINAL_SUBJECT_POLICY_VERSION || sealed.intent.impulse !== ORIGINAL_SUBJECT_ASSERTION_KERNEL.impulse
      || sealed.intent.subjects.length !== 1 || declaration?.kind !== "directory" || sealed.subjects.length !== 1 || declaration.id !== subject?.subjectId
      || !Number.isSafeInteger(subject.byteLength) || (subject.byteLength ?? -1) < 0 || sealed.intent.constraints.length || sealed.intent.requestedAssays.length) return undefined;
    const contract = compileIntentContract({ impulse: ORIGINAL_SUBJECT_ASSERTION_KERNEL.impulse, subjectIds: [subject.subjectId] });
    if (contract.digest !== sealed.intentContractDigest || contract.digest !== input.intentContractDigest || !same(contract, sealed.intentContract)
      || !same(contract, input.intentContract) || contract.criticalObligations.length !== 1 || !same(obligationsFromIntentContract(contract), input.obligations)) return undefined;
    const obligation = contract.criticalObligations[0]!;
    if (obligation.assayability !== "ASSAYABLE" || obligation.oracle?.kind !== "sealed_test_suite") return undefined;
    return Object.freeze({ subjectId: subject.subjectId, obligationId: obligation.id, captureDigest: sealed.subjectMaterialCaptureDigest, caseDigest: sealed.caseDigest, runDigest: sealed.runDigest });
  } catch { return undefined; }
}

/** Exact sealed Bone selection only. Runtime producer policy remains separately pinned. */
export function originalSubjectKernelDigestFromPolicyDescriptor(descriptor: unknown): string | undefined {
  try {
    const policy = record(record(descriptor)?.policy), selection = record(policy?.genomeSelection), compilation = record(selection?.runtimeCompilation);
    const bone = record(compilation?.bone), kernel = record(bone?.originalSubjectAssertionKernel), wasm = record(bone?.policyKernel);
    if (!bone || !selection || !kernel || bone.version !== "bone-v2" || compilation?.boneDigest !== digestJson(bone as JsonValue)
      || policy?.genomeSelectionDigest !== digestJson(selection as JsonValue) || kernel.protocol !== ORIGINAL_SUBJECT_ASSERTION_KERNEL.protocol
      || kernel.descriptorDigest !== ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST || kernel.implementationDigest !== ORIGINAL_SUBJECT_ASSERTION_IMPLEMENTATION_DIGEST
      || wasm?.sourceDigest !== REGO_POLICY_V2_SOURCE_DIGEST || wasm.wasmDigest !== REGO_POLICY_V2_WASM_DIGEST || wasm.entrypoint !== "jevyr/bone/axes" || !intact()) return undefined;
    return ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST;
  } catch { return undefined; }
}
