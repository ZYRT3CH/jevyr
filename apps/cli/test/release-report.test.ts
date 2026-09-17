import { describe, expect, it } from "vitest";
import { createReleaseReport } from "../src/release-report.js";
import type { BenchmarkCorpus } from "../src/benchmark.js";

const corpus: BenchmarkCorpus = {
  protocol: "jevyr.benchmark-corpus/1", requiredInvariants: [],
  cases: [{ id: "unexecuted-critical-claim", category: "evidence_authority", impulse: "Unexecuted claim", expect: { creation: "PRESENT", judgment: "UNPROVEN" } }],
};

describe("measured release report", () => {
  it("keeps every gate open when no authenticated case was observed", () => {
    const report = createReleaseReport(corpus, []);
    expect(report.releaseReady).toBe(false);
    expect(report.gates).toHaveLength(17);
    expect(report.gates.every((gate) => gate.status === "OPEN")).toBe(true);
  });
  it("does not elevate an expected verdict match without an authenticated Record and replay", () => {
    const report = createReleaseReport(corpus, [{ id: "unexecuted-critical-claim", passed: true, failures: [] }]);
    expect(report.gates.find((gate) => gate.id === "unexecuted-critical")?.status).toBe("OPEN");
    expect(report.cases[0]?.independentReplay).toBe(false);
  });
});
