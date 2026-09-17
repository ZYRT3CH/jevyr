import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sha256Digest, type JevyrVerdict } from "@jevyr/protocol";
import type { InvestigationAuditFinding } from "./investigation-audits.js";
import type { PolicyInput } from "./policy.js";
import { assessFormalCounterexamples } from "./formal-counterexamples.js";
import { REGO_POLICY_SOURCE_DIGEST, REGO_POLICY_WASM_DIGEST } from "./policy-identity.js";
import { REGO_POLICY_V2_SOURCE_DIGEST, REGO_POLICY_V2_WASM_DIGEST } from "./policy-v2-identity.js";
import { ORIGINAL_SUBJECT_POLICY_VERSION, originalSubjectPurpose } from "./original-subject.js";
export { REGO_POLICY_V2_SOURCE_DIGEST, REGO_POLICY_V2_WASM_DIGEST } from "./policy-v2-identity.js";
export { REGO_POLICY_SOURCE_DIGEST, REGO_POLICY_WASM_DIGEST, REGO_POLICY_COMPILER } from "./policy-identity.js";

export type PolicyAxes = Pick<JevyrVerdict, "integrity" | "creation" | "embodiment" | "judgment">;

// Installed policy bytes are bound once at module startup. They cannot be
// replaced by a Genome, a submitted file, an evaluator, or a model output.
const wasm = readFileSync(new URL("../policy/judgment.wasm", import.meta.url));
const source = readFileSync(new URL("../policy/judgment.rego", import.meta.url));
if (sha256Digest(wasm) !== REGO_POLICY_WASM_DIGEST || sha256Digest(source) !== REGO_POLICY_SOURCE_DIGEST) throw new Error("Installed Rego/WASM policy digest mismatch");
// The package's ESM wrapper does not export its synchronous loader.
const { loadPolicySync } = createRequire(import.meta.url)("@open-policy-agent/opa-wasm") as typeof import("@open-policy-agent/opa-wasm");
const policy = loadPolicySync(wasm);
let policyV2: ReturnType<typeof loadPolicySync> | undefined;
function selectedPolicy(version: string | undefined): ReturnType<typeof loadPolicySync> {
  // Historical caller labels retain the original module and semantics.
  if (version !== ORIGINAL_SUBJECT_POLICY_VERSION) return policy;
  if (!policyV2) {
    const nextWasm = readFileSync(new URL("../policy/judgment-v2.wasm", import.meta.url));
    const nextSource = readFileSync(new URL("../policy/judgment-v2.rego", import.meta.url));
    if (sha256Digest(nextWasm) !== REGO_POLICY_V2_WASM_DIGEST || sha256Digest(nextSource) !== REGO_POLICY_V2_SOURCE_DIGEST) throw new Error("Installed original-subject Rego/WASM policy digest mismatch");
    policyV2 = loadPolicySync(nextWasm);
  }
  return policyV2;
}

export function evaluateWasmPolicy(input: PolicyInput, auditFindings: readonly InvestigationAuditFinding[] = []): PolicyAxes {
  const formal = assessFormalCounterexamples(input);
  const originalSubject = originalSubjectPurpose(input) !== undefined;
  const result: unknown = selectedPolicy(input.policyVersion).evaluate({
    originalSubjectPurpose: originalSubject,
    candidates: [...input.candidates].sort((a, b) => a.id.localeCompare(b.id)),
    assays: input.assays,
    obligations: input.obligations.map((obligation) => ({
      ...obligation,
      assayability: obligation.assayability ?? "assayable",
      supportWeight: input.graph.strongestSupport(obligation.id, originalSubject).weight,
      refutationWeight: formal.verified.some((proof) => proof.obligationId === obligation.id)
        ? Math.max(3, input.graph.strongestSupport(obligation.id, originalSubject).weight)
        : input.graph.strongestRefutation(obligation.id, originalSubject).weight,
    })),
    integrityIssues: [...(input.integrityIssues ?? []), ...(formal.rejectedEvidenceIds.length === 0 ? [] : [{ severity: "fatal", phase: "pre_judgment" }])],
    creationFailed: input.creationFailed ?? false,
    auditFindings,
  }, "jevyr/bone/axes");
  if (!Array.isArray(result) || result.length !== 1 || result[0] === null || typeof result[0] !== "object") throw new Error("Rego/WASM policy did not produce exactly one decision");
  const axes = (result[0] as { result?: unknown }).result;
  if (axes === null || typeof axes !== "object") throw new Error("Rego/WASM policy returned malformed axes");
  const value = axes as PolicyAxes;
  if (!["VALID", "INVALID"].includes(value.integrity) || !["CONCEIVED", "NO_SURVIVOR", "FAILED"].includes(value.creation) || !["BUILT", "NOT_BUILT", "FAILED"].includes(value.embodiment) || !["ACCEPT", "REJECT", "UNPROVEN", "NOT_APPLICABLE"].includes(value.judgment)) throw new Error("Rego/WASM policy returned unknown axes");
  return Object.freeze({ integrity: value.integrity, creation: value.creation, embodiment: value.embodiment, judgment: value.judgment });
}

export function assertPolicyParity(expected: PolicyAxes, actual: PolicyAxes): void {
  for (const axis of ["integrity", "creation", "embodiment", "judgment"] as const) if (expected[axis] !== actual[axis]) throw new Error(`Rego/WASM policy parity failure on ${axis}: reference=${expected[axis]}, wasm=${actual[axis]}`);
}
