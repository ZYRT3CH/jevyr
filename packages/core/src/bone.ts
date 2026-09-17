import { digestJson, type JsonValue } from "@jevyr/protocol";
import { REGO_POLICY_SOURCE_DIGEST, REGO_POLICY_WASM_DIGEST, REGO_POLICY_COMPILER } from "./policy-identity.js";
import { FORMAL_COUNTEREXAMPLE_IMPLEMENTATION_DIGEST, FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST } from "./formal-counterexamples.js";
import { REGO_POLICY_V2_SOURCE_DIGEST, REGO_POLICY_V2_WASM_DIGEST } from "./policy-v2-identity.js";
import { ORIGINAL_SUBJECT_ASSERTION_IMPLEMENTATION_DIGEST, ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST } from "./original-subject.js";

export const JEVYR_BONE_DESCRIPTOR_PROTOCOL = "jevyr.bone-descriptor/1" as const;

/**
 * Runtime-owned constitutional identity. A Genome may name this digest, but it
 * cannot supply or alter the descriptor that produces it.
 */
export const JEVYR_BONE_DESCRIPTOR = Object.freeze({
  protocol: JEVYR_BONE_DESCRIPTOR_PROTOCOL,
  version: "bone-v1",
  postSealSemanticInput: "forbidden",
  hypothesisAuthority: "proposal-only",
  verdictAuthority: "deterministic-typed-evidence-policy",
  policyKernel: Object.freeze({
    engine: "opa-wasm",
    compiler: REGO_POLICY_COMPILER,
    sourceDigest: REGO_POLICY_SOURCE_DIGEST,
    wasmDigest: REGO_POLICY_WASM_DIGEST,
    entrypoint: "jevyr/bone/axes",
    typescriptParity: "mandatory-fail-closed",
  }),
  formalProofKernel: Object.freeze({
    protocol: "jevyr.formal-counterexample-kernel/1",
    descriptorDigest: FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST,
    implementationDigest: FORMAL_COUNTEREXAMPLE_IMPLEMENTATION_DIGEST,
    authority: "exact-sealed-statement-and-rechecked-finite-arithmetic",
    modelCertificates: "forbidden",
  }),
  selectionAuthority: "closed-measured-archive-only",
  firstDivergenceMemory: "amnesic",
  maximumLateMemoryInfluence: 0.2,
  liveBoneMutation: "forbidden",
  genomePromotion: "signed-governance-only",
  genomeRuntimeCompiler: Object.freeze({
    protocol: "jevyr.genome-runtime-profile/1",
    builtinCatalogDigest: "sha256:410ee659e0cca622285af475f6c47a3a190829a009043c484ad3b07e64414a6d",
    dynamicArtifactLoading: "forbidden",
  }),
  evidenceStore: Object.freeze({
    protocol: "jevyr.evidence-store-policy/1",
    canonicalEncoding: "jevyr-canonical-json/1",
    maximumObservationBytes: 2_097_152,
    maximumCaseBytes: 67_108_864,
    missingOrCorruptEvidence: "non-adjudicative",
  }),
} as const);

/** Independently computed by Bone; never read from a Genome artifact. */
export const JEVYR_BONE_DIGEST = digestJson(JEVYR_BONE_DESCRIPTOR as unknown as JsonValue);

/** Explicit opt-in only. The default descriptor/export above remains v1. */
export const JEVYR_BONE_V2_DESCRIPTOR = Object.freeze({
  ...JEVYR_BONE_DESCRIPTOR,
  version: "bone-v2",
  policyKernel: Object.freeze({ ...JEVYR_BONE_DESCRIPTOR.policyKernel, sourceDigest: REGO_POLICY_V2_SOURCE_DIGEST, wasmDigest: REGO_POLICY_V2_WASM_DIGEST }),
  originalSubjectAssertionKernel: Object.freeze({
    protocol: "jevyr.original-subject-assertion-kernel/1",
    descriptorDigest: ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST,
    implementationDigest: ORIGINAL_SUBJECT_ASSERTION_IMPLEMENTATION_DIGEST,
    authority: "exact-original-capture-certificate-and-physical-execution-replay",
    candidateAlias: "forbidden",
  }),
} as const);
export const JEVYR_BONE_V2_DIGEST = digestJson(JEVYR_BONE_V2_DESCRIPTOR as unknown as JsonValue);
