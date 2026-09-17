import { describe, expect, it } from "vitest";
import { sha256Digest } from "@jevyr/protocol";
import { derivePhysicalReproducibility } from "../src/index.js";
function capture(text: string) {
  const bytes = Buffer.from(text);
  return { schema: "jevyr.exact-byte-capture/1", encoding: "base64", data: bytes.toString("base64"), byteLength: bytes.length, observedByteLength: bytes.length, complete: true, utf8: "valid", digest: sha256Digest(bytes) };
}
function observation() {
  return { invocationId: "first", startedAt: "now", metadata: { assayId: "predicate-0", candidateId: "first", candidateBlueprintDigest: sha256Digest("source-comments"), admissible: true, typedOracleStatus: "PASSED" },
    oracle: { execution: { command: "node", args: ["check.mjs"], mode: "docker", state: "exited", exitCode: 0, shell: false, outputTruncated: false,
      stdoutCapture: capture("actual=1\n"), stderrCapture: capture(""), substrate: { executionImageId: sha256Digest("image"), startupResolvedImageId: sha256Digest("image") } } } };
}
describe("physical-result reproducibility", () => {
  it("ignores run identity and ordering while preserving repeated execution multiplicity", () => {
    const first = observation(), second = observation();
    second.invocationId = "next"; second.startedAt = "later"; second.metadata.candidateId = "next"; second.metadata.candidateBlueprintDigest = sha256Digest("different-comments");
    expect(derivePhysicalReproducibility([first]).digest).toBe(derivePhysicalReproducibility([second]).digest);
    expect(derivePhysicalReproducibility([first, second]).digest).toBe(derivePhysicalReproducibility([second, first]).digest);
    expect(derivePhysicalReproducibility([first]).digest).not.toBe(derivePhysicalReproducibility([first, second]).digest);
  });
  it("never normalizes output bytes, command semantics or image identity away", () => {
    const original = observation(), expected = derivePhysicalReproducibility([original]).digest;
    for (const mutate of [
      (value: ReturnType<typeof observation>) => { value.oracle.execution.stdoutCapture = capture("actual=2\n"); },
      (value: ReturnType<typeof observation>) => { value.oracle.execution.stderrCapture = capture("warning"); },
      (value: ReturnType<typeof observation>) => { value.oracle.execution.args = ["other.mjs"]; },
      (value: ReturnType<typeof observation>) => { value.oracle.execution.substrate.executionImageId = value.oracle.execution.substrate.startupResolvedImageId = sha256Digest("different-image"); },
    ]) { const changed = observation(); mutate(changed); expect(derivePhysicalReproducibility([changed]).digest).not.toBe(expected); }
  });
  it("refuses incomplete, forged and nonadmissible physical captures without guessing equivalence", () => {
    for (const mutate of [
      (value: ReturnType<typeof observation>) => { value.oracle.execution.stdoutCapture.complete = false; },
      (value: ReturnType<typeof observation>) => { value.oracle.execution.stdoutCapture.digest = sha256Digest("forged"); },
      (value: ReturnType<typeof observation>) => { value.metadata.admissible = false; },
    ]) { const changed = observation(); mutate(changed); expect(derivePhysicalReproducibility([observation(), changed]).digest).toBeNull(); }
    expect(derivePhysicalReproducibility([]).digest).toBeNull();
  });
});
