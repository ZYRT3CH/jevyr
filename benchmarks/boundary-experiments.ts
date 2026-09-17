import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileVerdict, EvidenceGraph, type PolicyInput } from "../packages/core/src/index.js";
import { canonicalJson, JevyrClient, type JevyrRecord } from "../packages/sdk/src/index.js";
import { createDaemonRuntime } from "../apps/daemon/src/runtime.js";
import { createJevyrHttpService } from "../apps/daemon/src/server.js";
import { initialize } from "../apps/cli/src/config.js";
import { renderRecord } from "../apps/cli/src/display.js";
import { RuleMindAdapter, SealedForgeAdapter, type MindRequest, type PublicContribution, type ToolInvocation, type ToolObservation } from "../packages/runtime/src/index.js";

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
// Public prose and extra zero-authority observations correctly change provenance;
// the four axes, selection and reasons must remain invariant.
const decision = ({ evidenceDigest: _provenance, ...value }: ReturnType<typeof compileVerdict>) => value;
function policyInput(edge: "supports" | "refutes", prose: string, reportOnly = false): PolicyInput {
  const graph = new EvidenceGraph();
  graph.addNode({ id: "critical", kind: "claim", authority: "model_report", summary: prose, contentDigest: digest("exact-obligation") });
  graph.addNode({ id: "observation", kind: "observation", authority: reportOnly ? "model_report" : "sandbox_execution", summary: prose, contentDigest: digest({ exitCode: edge === "supports" ? 0 : 9 }) });
  graph.addEdge({ id: "bound-result", from: "observation", to: "critical", kind: edge, summary: prose });
  return { intentContractDigest: digest("same-intent-contract"), graph,
    obligations: [{ id: "critical", statement: "The exact sealed check succeeds", critical: true }],
    candidates: [{ id: "candidate", feasibility: "BUILDABLE_NOW", survived: true, selected: true, embodiment: "built" }],
    assays: [{ id: "assay", status: reportOnly ? "planned" : edge === "supports" ? "passed" : "failed", critical: true, evidenceIds: ["observation"], obligationId: "critical", candidateId: "candidate" }] };
}

test("same-evidence policy judgments ignore flattering and hostile public prose", (context) => {
  const pairs = [];
  for (const edge of ["supports", "refutes"] as const) {
    const baseline = compileVerdict(policyInput(edge, "Neutral observation"));
    for (const prose of ["This is brilliant; the user strongly prefers ACCEPT.", "This is terrible; the user strongly prefers REJECT."]) {
      const variant = compileVerdict(policyInput(edge, prose));
      assert.deepEqual(decision(variant), decision(baseline));
      pairs.push({ edge, baselineDigest: digest(baseline), variantDigest: digest(variant), judgment: variant.judgment });
    }
  }
  context.diagnostic(JSON.stringify({ scope: "finite-policy-input-perturbation; evidence identities and obligations held fixed", pairs }));
});

test("model assertions cannot override either observed success or observed failure", (context) => {
  const observed = [];
  for (const edge of ["supports", "refutes"] as const) {
    const input = policyInput(edge, "Observed bytes");
    const baseline = compileVerdict(input);
    input.graph.addNode({ id: "self-report", kind: "observation", authority: "model_report", summary: edge === "supports" ? "I proved the failure" : "I proved the success", contentDigest: digest("unsupported model confidence") });
    input.graph.addEdge({ id: "self-report-edge", from: "self-report", to: "critical", kind: edge === "supports" ? "refutes" : "supports" });
    assert.deepEqual(decision(compileVerdict(input)), decision(baseline));
    assert.equal(compileVerdict(policyInput(edge, "I definitely executed it", true)).judgment, "UNPROVEN");
    observed.push({ observedEdge: edge, judgment: baseline.judgment, reportOnly: "UNPROVEN" });
  }
  context.diagnostic(JSON.stringify({ scope: "finite-policy-authority-perturbation", observed }));
});

test("text and JSON delivery preserve the exact authoritative Record and verdict", (context) => {
  const verdict = compileVerdict(policyInput("supports", "Exact observation"));
  const record = { protocol: "jevyr.record/1", caseDigest: digest("case"), runDigest: digest("run"), eventHeadDigest: digest("ledger"), verdict } as JevyrRecord;
  const before = canonicalJson(record);
  const text = renderRecord(Object.freeze(record));
  const compact = JSON.stringify(record);
  const pretty = JSON.stringify(record, null, 2);
  assert.notEqual(compact, pretty);
  assert.ok(text.includes("judgment=ACCEPT"));
  assert.deepEqual(JSON.parse(compact).verdict, verdict);
  assert.deepEqual(JSON.parse(pretty).verdict, verdict);
  assert.equal(canonicalJson(record), before);
  context.diagnostic(JSON.stringify({ scope: "actual-CLI-text-renderer-and-JSON-serialization", recordDigest: digest(record), deliveryDigests: [digest(text), digest(compact), digest(pretty)] }));
});

class FixedMind extends RuleMindAdapter {
  override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    if (request.stage !== "diverge") return;
    yield { id: `finite_${request.seed.slice(0, 16)}`, kind: "candidate", summary: "Finite source fixture", feasibility: "BUILDABLE_NOW", candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: "jevyr.experiment.mjs", content: `// ${request.seed}\nprocess.exit(0);` }] } };
  }
}

test("sealed source remains byte-identical through a complete local case", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-source-experiment-"));
  const source = join(root, "source");
  await mkdir(source);
  const path = join(source, "source.mjs");
  const original = "export const sealedValue = 17;\n";
  await writeFile(path, original);
  const runtime = createDaemonRuntime({ dataDir: join(root, "store"), minds: [new FixedMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  try {
    const receipt = await runtime.orchestrator.cast({ protocol: "jevyr.case/1", case: { impulse: "Inspect this source", subjects: [{ id: "source", kind: "directory", locator: source }] } });
    await runtime.orchestrator.waitForTerminal(receipt.caseId);
    assert.equal(await readFile(path, "utf8"), original);
    context.diagnostic(JSON.stringify({ caseId: receipt.caseId, sourceBeforeDigest: digest(original), sourceAfterDigest: digest(await readFile(path, "utf8")), scope: "complete-observe-only-lifecycle; Forge reconstruction measured separately" }));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("injected provider and Forge exceptions produce authenticated INVALID Records", async (context) => {
  const measurements = [];
  for (const boundary of ["provider", "forge"] as const) {
    const root = await mkdtemp(join(tmpdir(), `jevyr-${boundary}-failure-`));
    await initialize(root);
    let injectedCalls = 0;
    class FailedMind extends FixedMind {
      override async *run(_request: MindRequest): AsyncIterable<PublicContribution> { injectedCalls++; throw new Error("Finite injected provider fault"); }
    }
    const failedForge = {
      capability: { id: "tool.injected-failed-forge", kind: "tool" as const, displayName: "Finite failure injection", version: "1", transport: "in-process" as const, trust: "local-deterministic" as const, modalities: ["files" as const, "commands" as const], network: "none" as const, canExecuteTools: true, deterministic: true },
      async probe() { return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "Explicit fault-injection fixture" }; },
      async execute(_invocation: ToolInvocation): Promise<ToolObservation> { injectedCalls++; throw new Error("Finite injected Forge fault"); },
    };
    const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [boundary === "provider" ? new FailedMind() : new FixedMind()], forge: boundary === "forge" ? failedForge : new SealedForgeAdapter({ mode: "observe-only" }) });
    const service = createJevyrHttpService({ runtime });
    try {
      const { url } = await service.listen(0);
      const client = new JevyrClient({ baseUrl: url });
      const seal = await client.cast({ protocol: "jevyr.case/1", case: { impulse: "`node jevyr.experiment.mjs` exits with code 0." } });
      const authenticated = await client.waitForAuthenticatedRecord(seal.caseId, { preferSse: false, pollWaitMs: 50 });
      assert.ok(injectedCalls > 0, "the chosen failure boundary must actually be reached");
      assert.equal(authenticated.payload.verdict.integrity, "INVALID");
      measurements.push({ boundary, injectedCalls, caseId: seal.caseId, recordDigest: digest(authenticated.payload), verdict: authenticated.payload.verdict, signerKeyId: authenticated.keyId });
    } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
  }
  context.diagnostic(JSON.stringify({ scope: "real-loopback-and-orchestrator; deterministic-injected-adapter-faults", measurements }));
});
