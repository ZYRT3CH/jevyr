import { describe, expect, it } from "vitest";
import { digestJson, validateCaseEventShape, type FormalCounterexampleCertificate, type JsonValue } from "@jevyr/protocol";
import { assessFormalCounterexamples, compileIntentContract, compileVerdict, constructFormalCounterexamples, createCaseEvent, evaluateReflex, EvidenceGraph, FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST, formalProofKernelDigestFromPolicyDescriptor, JEVYR_BONE_DESCRIPTOR, JEVYR_BONE_DIGEST, projectEvents, verifyFormalCounterexample } from "../src/index.js";

const impossible = "Build a finite lossless encoder that maps every possible finite byte string to a strictly shorter byte string, then judge the original request rather than silently substituting an easier one.";
const digest = digestJson({ fixture: "formal-proof" });
function setup(impulse = impossible, mutate?: (certificate: FormalCounterexampleCertificate) => void, actor: "kernel" | "mind" = "kernel") {
  const contract = compileIntentContract({ impulse });
  const certificate = structuredClone(constructFormalCounterexamples(contract)[0]!);
  if (certificate) mutate?.(certificate);
  const events = certificate ? [createCaseEvent({
    caseDigest: digest, runDigest: digest, observedAt: "2026-09-05T00:00:00.000Z", stage: "assay", kind: "evidence.observed",
    actor: { id: actor === "kernel" ? "jevyr.bone" : "mind.model", kind: actor },
    payload: { evidenceId: "formal-proof", evidenceType: "tool_observation", summary: "An exact finite counterexample certificate.", contentDigest: digestJson(certificate as unknown as JsonValue), formalProof: certificate },
  }, 1, null)] : [];
  return { contract, certificate, events, input: projectEvents(events, { intentContract: contract, formalProofKernelDigest: FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST }).input };
}

describe("bounded formal counterexamples", () => {
  it("proves the original total mapping impossible using its empty domain member, without sandbox or model authority", () => {
    const { contract, certificate, input } = setup();
    expect(certificate.source.text).toBe("maps every possible finite byte string to a strictly shorter byte string");
    expect(contract.goal.statement.slice(certificate.source.start, certificate.source.end)).toBe(certificate.source.text);
    expect(certificate.witness).toEqual({ inputLength: 0, inputHex: "", maximumOutputLength: -1 });
    expect(verifyFormalCounterexample(certificate, contract)).toBe(true);
    const verdict = compileVerdict(input);
    expect(verdict).toMatchObject({ integrity: "VALID", judgment: "REJECT", embodiment: "NOT_BUILT" });
    expect(verdict.basis).toContainEqual(expect.objectContaining({ code: "FORMAL_COUNTEREXAMPLE_VERIFIED", evidenceIds: ["formal-proof"] }));
    expect(input.graph.snapshot().nodes.every((node) => node.authority !== "sandbox_execution")).toBe(true);
    expect(evaluateReflex(verdict, input, { loop: 1, canAcquireMaterialEvidence: false }).materialFindings).toEqual([]);
    expect(compileVerdict({ ...input, auditEvents: [] }).judgment).toBe("UNPROVEN");
  });

  it.each([
    "Create a mapping that maps every finite bit string to a strictly shorter bit string.",
    "Implement a finite function that maps every possible finite byte string to a byte string at least 32 bytes shorter.",
    "forall input in ByteString(minLength=0): len(output) <= len(input) - 7",
    "forall input in BitString(minLength=0): len(output) <= len(input) - 1",
  ])("checks a general finite length requirement: %s", (statement) => {
    const { input } = setup(statement);
    expect(assessFormalCounterexamples(input).verified).toHaveLength(1);
    expect(compileVerdict(input).judgment).toBe("REJECT");
  });

  it.each([
    impossible.replace("every possible finite", "every nonempty finite"),
    impossible.replace("every possible finite", "some finite"),
    impossible.replace("a strictly shorter", "an equally long"),
    impossible.replace("a strictly shorter", "an on-average shorter"),
    impossible.replace("byte string, then", "byte string except for the empty input, then"),
    impossible.replace("byte string, then", "byte string when possible, then"),
    impossible.replace("byte string, then", "byte string with external metadata, then"),
    impossible.replace("byte string, then", "byte string asymptotically, then"),
    `Do not ${impossible.toLowerCase()}`,
    `Explain why someone claims: ${impossible}`,
    `A model said "${impossible}"`,
    `${impossible} Exclude the empty input.`,
    impossible.replace("maps every", "might map every"),
    "Build a mapping that maps every finite byte string to a bit string at least 1 bits shorter.",
    "Build a mapping that maps every finite byte string to a byte string at least 1 bits shorter.",
    "forall input in ByteString(minLength=1): len(output) <= len(input) - 1",
    "forall input in ByteString(minLength=0): len(output) <= len(input) - 0",
    "forall input in ByteString(minLength=0): len(output) <= len(input) - 1000000",
    "Prove that P is unequal to NP.",
  ])("leaves unknown, qualified or ambiguous domains unproven: %s", (statement) => {
    const contract = compileIntentContract({ impulse: statement });
    expect(constructFormalCounterexamples(contract)).toEqual([]);
    expect(compileVerdict(projectEvents([], { intentContract: contract }).input).judgment).toBe("UNPROVEN");
  });

  it.each([
    (proof: FormalCounterexampleCertificate) => { proof.intentContractDigest = digest; },
    (proof: FormalCounterexampleCertificate) => { proof.statementDigest = digest; },
    (proof: FormalCounterexampleCertificate) => { proof.obligationId = "other-obligation"; },
    (proof: FormalCounterexampleCertificate) => { proof.source.start += 1; proof.source.end += 1; },
    (proof: FormalCounterexampleCertificate) => { proof.proposition.domain = "all_finite_bit_strings"; },
    (proof: FormalCounterexampleCertificate) => { proof.proposition.requiredSaving = 2; },
    (proof: FormalCounterexampleCertificate) => { proof.witness.maximumOutputLength = -2; },
  ])("rejects content-addressed but semantically forged certificates", (mutate) => {
    const { input } = setup(impossible, mutate);
    expect(assessFormalCounterexamples(input).rejectedEvidenceIds).toEqual(["formal-proof"]);
    expect(compileVerdict(input)).toMatchObject({ integrity: "INVALID", judgment: "NOT_APPLICABLE" });
  });

  it("does not accept a model-origin certificate or transfer a proof to a qualified contract", () => {
    expect(compileVerdict(setup(impossible, undefined, "mind").input).integrity).toBe("INVALID");
    const original = setup();
    const other = compileIntentContract({ impulse: impossible.replace("every possible finite", "every nonempty finite") });
    expect(verifyFormalCounterexample(original.certificate, other)).toBe(false);
  });

  it("refuses separately declared exceptions, subject-defined domains and unsealed proof checkers", () => {
    for (const extra of [{ constraints: ["Exclude empty inputs."] }, { subjectIds: ["domain-definition"] }, { requestedAssays: ["nonempty-only"] }]) {
      const contract = compileIntentContract({ impulse: impossible, ...extra });
      expect(constructFormalCounterexamples(contract)).toEqual([]);
      const proof = { ...setup().certificate, intentContractDigest: contract.digest };
      expect(verifyFormalCounterexample(proof, contract)).toBe(false);
    }
    const { input } = setup();
    delete input.formalProofKernelDigest;
    expect(compileVerdict(input).integrity).toBe("INVALID");
    const genomeSelection = { runtimeCompilation: { bone: JEVYR_BONE_DESCRIPTOR, boneDigest: JEVYR_BONE_DIGEST } };
    const descriptor = { policy: { genomeSelection, genomeSelectionDigest: digestJson(genomeSelection as unknown as JsonValue) } };
    expect(formalProofKernelDigestFromPolicyDescriptor(descriptor)).toBe(FORMAL_COUNTEREXAMPLE_KERNEL_DIGEST);
    expect(formalProofKernelDigestFromPolicyDescriptor({ policy: {} })).toBeUndefined();
    expect(formalProofKernelDigestFromPolicyDescriptor({ policy: { ...descriptor.policy, genomeSelectionDigest: digest } })).toBeUndefined();
  });

  it("formal proof survives flattering display prose while its sealed truth conditions stay exact", () => {
    const { input } = setup();
    const baseline = compileVerdict(input);
    const graph = input.graph.snapshot();
    const variant = compileVerdict({ ...input, graph: EvidenceGraph.from({
      ...graph, nodes: graph.nodes.map(node => node.kind === "claim" ? { ...node, summary: `A wonderful result: ${node.summary}` } : node),
    }) });
    expect(variant.judgment).toBe(baseline.judgment);
    expect(variant.integrity).toBe(baseline.integrity);
    expect(variant.basis).toEqual(baseline.basis);
  });

  it("closes the certificate wire schema against extra fields, domain substitutions, and sandbox aliases", () => {
    const { events } = setup();
    expect(validateCaseEventShape(events[0]).ok).toBe(true);
    for (const mutate of [
      (event: any) => { event.payload.formalProof.verdict = "REJECT"; },
      (event: any) => { event.payload.formalProof.proposition.minimumInputLength = 1; },
      (event: any) => { event.payload.formalProof.witness.maximumOutputLength = 0; },
      (event: any) => { event.payload.formalProof.source.end += 1; },
      (event: any) => { event.payload.evidenceType = "sandbox_execution"; },
      (event: any) => { event.payload.evidenceType = "model_report"; },
      (event: any) => { event.payload.refutes = [event.payload.formalProof.obligationId]; },
    ]) {
      const event = structuredClone(events[0]);
      mutate(event);
      event!.payload.contentDigest = digestJson(event!.payload.formalProof as unknown as JsonValue);
      expect(validateCaseEventShape(event).ok).toBe(false);
    }
  });
});
