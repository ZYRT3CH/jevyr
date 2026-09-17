import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { canonicalize, createSearchEnvelope, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { makePublicMindPrompt, parsePublicContributions } from "../src/adapters/prompt.js";
import type { ExperimentCapability, MindRequest, SealedCaseContext } from "../src/contracts.js";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import { REVISION_INVESTIGATION_POLICY } from "../src/revision-investigation.js";

const digest = sha256Digest("generic-revision-prompt-fixture");
const contract = compileIntentContract({ impulse: "Inspect the captured arithmetic module and deliver a runnable observation." });
const sealed: SealedCaseContext = {
  protocol: "jevyr.case/1", caseId: "case_revision_prompt_fixture", submissionDigest: digest,
  subjectMaterialCaptureDigest: digest, caseDigest: digest, runDigest: digest,
  sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "jevyr.bone/2", policyDigest: digest,
  genomeVersion: "fixture", genomeDigest: digest, searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
  intentContractDigest: contract.digest, intentContract: contract,
  intent: { impulse: "Inspect the captured arithmetic module and deliver a runnable observation.", mode: "auto", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control: "sovereign", seed: "held" }, subjects: [],
};
const capability: ExperimentCapability = {
  protocol: "jevyr.experiment-capability/1", frontierDigest: digest, intentContractDigest: contract.digest, digest,
  experiments: [{ assayId: "fixture.observe", costUnits: 1, timeoutMs: 5000, tool: "forge.command", entryFile: "probe.mjs", authority: "comparative-only", command: { executable: "node", args: ["probe.mjs"], shell: false } }],
};
const parentContent = 'import { compute } from "./missing.mjs";\nprocess.stdout.write(String(compute()));\n';
function request(withParent = true): MindRequest {
  return {
    sealed, stage: "reflex", role: "reflex", seed: "held-revision", constraints: [], investigationTools: true,
    signal: new AbortController().signal, experimentCapability: capability, maxInputTokens: 12000, maxOutputTokens: 2000,
    revision: { round: 1, parentCandidateIds: ["committed-parent"], contextDigest: digest },
    ...(withParent ? { revisionSources: [{ candidateId: "committed-parent", blueprintDigest: digest, files: [{ path: "probe.mjs", content: parentContent, digest: sha256Digest(parentContent) }] }] } : {}),
    publicFacts: [{ id: "actual-failure", kind: "observation", summary: "The parent exited 1 with ERR_MODULE_NOT_FOUND.", tags: ["executed-assay-context"] }],
  };
}
const parse = (input: MindRequest, contribution: unknown) => parsePublicContributions(JSON.stringify({ contributions: [contribution] }), "mind.fixture", input, { strictStructured: true });
const candidate = { kind: "candidate", summary: "A finite proposed repair; not executed.", parentIds: ["committed-parent"], blueprint: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: "probe.mjs", content: 'process.stdout.write("unexecuted proposal");\n' }], command: { executable: "node", args: ["probe.mjs"] } } };

test("scheduled revision prioritizes complete executable delivery over an assessment-only diagnosis", () => {
  const prompt = makePublicMindPrompt(request());
  assert.match(prompt, /scheduled task is an executable repair of the failed generated parent/u);
  assert.match(prompt, /Default deliverable: exactly one kind candidate.*committed-parent/u);
  assert.match(prompt, /A prose diagnosis alone does not deliver this repair/u);
  assert.match(prompt, /read_revision_lines to inspect the generated program/u);
  assert.ok(prompt.indexOf("Default deliverable:") < prompt.indexOf("If no admissible executable repair"));
  assert.match(prompt.split("\n").at(-1)!, /^Deliver one complete executable candidate revision.*Only if no admissible repair can be justified/u);
  assert.doesNotMatch(prompt, /either kind reflex.*or kind candidate|candidate revision or one public Reflex assessment/u);
  assert.equal(parse(request(), candidate)[0]?.kind, "candidate");
});

test("unavailable source and an immutable-source defect permit an honest refusal without inventing a repair", () => {
  const input = request(false), prompt = makePublicMindPrompt(input);
  assert.match(prompt, /UNAVAILABLE_OR_WITHHELD: do not invent unseen parent implementation details/u);
  assert.match(prompt, /Missing or withheld source, an unsupported failure claim, or a required change outside the permitted generated parent can justify this refusal/u);
  assert.match(prompt, /blueprint rules below apply only when returning a candidate/u);
  assert.match(prompt, /Do not fabricate certainty, unseen source, a repair or a passing result/u);
  for (const summary of ["The parent source is withheld, so no admissible repair can be justified.", "The observed original-source defect requires a change outside the generated program; no repair supplied."]) {
    const result = parse(input, { kind: "reflex", summary });
    assert.equal(result[0]?.kind, "reflex");
    assert.equal(result[0]?.candidateBlueprintSource, undefined);
  }
});

test("repair instructions preserve original bytes, expected outputs, command and existing failure history", () => {
  const input = request(), before = canonicalize({ revision: input.revision, capability, facts: input.publicFacts, search: sealed.searchEnvelope } as unknown as JsonValue);
  const prompt = makePublicMindPrompt(input);
  assert.match(prompt, /Captured original subject bytes, supplied expected outputs, and the sealed command and evaluator remain unchanged/u);
  assert.match(prompt, /When the task requires observing original-source behavior, do not substitute a corrected source copy/u);
  assert.match(prompt, /An original-source defect may remain after a valid repair/u);
  assert.match(prompt, /All prior failures remain part of the record/u);
  assert.match(prompt, /no extra revision rounds, resource allowance or verdict authority/u);
  assert.equal(REVISION_INVESTIGATION_POLICY.maximumBaselineRounds, 2);
  assert.equal(REVISION_INVESTIGATION_POLICY.verdictAuthority, "none");
  assert.equal(canonicalize({ revision: input.revision, capability, facts: input.publicFacts, search: sealed.searchEnvelope } as unknown as JsonValue), before);
  assert.equal(input.maxInputTokens, 12000); assert.equal(input.maxOutputTokens, 2000);
});

test("clarification discloses no parent bytes or unprovided oracle result and remains channel neutral", () => {
  const prompt = makePublicMindPrompt(request());
  assert.equal(prompt.includes(parentContent), false);
  assert.equal(prompt.includes(sha256Digest(parentContent)), false);
  assert.equal(prompt.includes('"expected":'), false);
  assert.equal(prompt.includes('"actual":'), false);
  assert.doesNotMatch(prompt, /jevyr\.context-tools\/1|tool_choice|response_format|Use native function calls/u);
  assert.match(prompt, /ERR_MODULE_NOT_FOUND/u, "Already-public actual failure remains available as context");
});

test("clarified task keeps existing finite-parent and sealed-command admission checks", () => {
  const input = request();
  assert.throws(() => parse(input, { ...candidate, parentIds: ["foreign-parent"] }), /permitted existing parent/u);
  assert.throws(() => parse(input, { ...candidate, blueprint: { ...candidate.blueprint, command: { executable: "node", args: ["different.mjs"] } } }), /sealed experiment capability/u);
  assert.throws(() => parse(input, { kind: "candidate", summary: "I repaired it in prose.", parentIds: ["committed-parent"] }), /revision is not finite/u);
  assert.throws(() => parsePublicContributions(JSON.stringify({ contributions: [candidate, { kind: "reflex", summary: "Another deliverable." }] }), "mind.fixture", input, { strictStructured: true }), /one finite revision or one Reflex assessment/u);
});

test("an explicitly requested application repair remains permitted in the generated candidate", () => {
  const input = request(), impulse = "Implement an application that doubles an input and repair its generated program if execution fails.";
  const applicationRequest: MindRequest = { ...input, sealed: { ...sealed, intent: { ...sealed.intent, impulse } },
    publicFacts: [{ id: "application-failure", kind: "observation", summary: "The generated application exited 1 with a syntax error.", tags: ["executed-assay-context"] }] };
  const prompt = makePublicMindPrompt(applicationRequest);
  assert.match(prompt, /Task-authorized application implementation or repair belongs in the generated candidate/u);
  assert.match(prompt, /When the task requires observing original-source behavior/u, "Original-behavior fidelity is conditional on the sealed task, not a ban on implementing application changes");
  assert.ok(prompt.includes(impulse));
  const repairedApplication = { ...candidate, summary: "A proposed implementation repair of the generated application.", blueprint: { ...candidate.blueprint,
    files: [{ path: "probe.mjs", content: 'const double = value => value * 2;\nprocess.stdout.write(JSON.stringify({result: double(7)}));\n' }] } };
  const [parsed] = parse(applicationRequest, repairedApplication);
  assert.equal(parsed?.kind, "candidate");
  assert.deepEqual(parsed?.candidateBlueprintSource, repairedApplication.blueprint);
  assert.deepEqual(parsed?.parentIds, ["committed-parent"]);
});

test("ordinary stages and already prepared exact prompts do not acquire revision instructions", () => {
  const { revision: _revision, revisionSources: _sources, ...ordinary } = request();
  for (const stage of ["interpret", "diverge", "recombine", "challenge", "reflex"] as const) {
    const prompt = makePublicMindPrompt({ ...ordinary, stage });
    assert.doesNotMatch(prompt, /scheduled task is an executable repair|Default deliverable:|Reflex refusal instead/u);
  }
  assert.equal(makePublicMindPrompt({ ...request(), preparedPublicPrompt: "Already bound exact prompt bytes\n" }), "Already bound exact prompt bytes\n");
});
