import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { liveModelCorpus, qualificationDigest } from "./live-model-fixtures.mjs";
import { assertRecoveryMeasurementDeclaration, recoveryMeasurementDeclaration, summarizeProbeRecoveryChronology,
  assertRecoveryTraceBinding, verifyProbeRecovery, RECOVERY_ANALYZER_ARCHIVE } from "./probe-recovery-measurement.mjs";

const physical = (candidateId, sequence, matched, invocationId = `physical-${sequence}`) => ({ candidateId, startedSequence: sequence, matched,
  invocationId, executed: true, artifactDigests: [qualificationDigest({ invocationId })], reasons: matched ? [] : ["actual output differs"] });
const initial = [{ candidateId: "parent", proposalSequence: 2 }];
const revision = (candidateId, parentCandidateId, closureSequence) => ({ candidateId, parentCandidateId, closureSequence });
const summarize = patch => summarizeProbeRecoveryChronology({ originalCandidates: initial, revisions: [], physicalRows: [], selectedCandidateId: undefined,
  strictQualified: false, failedProviderCalls: 0, ...patch });

test("a correct later child remains separate from its failed parent and unchanged strict failure", () => {
  const report = summarize({ revisions: [revision("child", "parent", 10)], physicalRows: [physical("parent", 5, false), physical("child", 12, true)], selectedCandidateId: "parent", failedProviderCalls: 1 });
  assert.equal(report.first.correct, false); assert.equal(report.selected.correct, false); assert.equal(report.latestRevision.correct, true);
  assert.equal(report.strictQualified, false); assert.equal(report.failedProviderCalls, 1);
  assert.equal(report.failedPhysicalAttempts, 1); assert.equal(report.allCandidates.length, 2);
  assert.equal(report.allCandidates[0].attempts[0].matched, false);
  assert.equal(report.firstLineageEventuallyDelivered, true);
});

test("selection follows authenticated chronology rather than whichever child or attempt happened to pass", () => {
  const report = summarize({ revisions: [revision("last", "good", 30), revision("good", "parent", 10)],
    physicalRows: [physical("last", 31, false), physical("good", 12, true), physical("parent", 5, false), physical("last", 32, false)], selectedCandidateId: "last" });
  assert.equal(report.latestRevision.candidateId, "last"); assert.equal(report.latestRevision.invocationId, "physical-32");
  assert.equal(report.latestRevision.correct, false); assert.equal(report.selected.correct, false);
  assert.equal(report.firstLineageEventuallyDelivered, false); assert.equal(report.failedPhysicalAttempts, 3);
});

test("an unexecuted earliest admission is not replaced by a later successful candidate", () => {
  const report = summarize({ originalCandidates: [{ candidateId: "later", proposalSequence: 9 }, ...initial],
    physicalRows: [physical("later", 11, true)], selectedCandidateId: "later" });
  assert.equal(report.first.candidateId, "parent"); assert.equal(report.first.status, "NOT_EXECUTED");
  assert.equal(report.first.correct, false); assert.equal(report.selected.correct, true);
  assert.deepEqual(report.unexecutedCandidates, ["parent"]); assert.equal(report.latestRevision.status, "NOT_SELECTED");
});

test("a different lineage's later correct repair does not become recovery of the first failed lineage", () => {
  const report = summarize({ originalCandidates: [...initial, { candidateId: "other", proposalSequence: 4 }],
    revisions: [revision("child", "other", 15)], physicalRows: [physical("parent", 5, false), physical("other", 7, false), physical("child", 18, true)] });
  assert.equal(report.latestRevision.correct, true); assert.equal(report.latestRevisionDescendsFromFirst, false);
  assert.equal(report.firstLineageEventuallyDelivered, false);
});

test("missing selection, duplicate physical accounting, foreign candidates and extra revision rounds fail closed", () => {
  const empty = summarize({ originalCandidates: [] }); assert.equal(empty.first.status, "NOT_SELECTED"); assert.equal(empty.strictQualified, false);
  assert.throws(() => summarize({ physicalRows: [physical("foreign", 1, true)] }), /committed candidate/u);
  assert.throws(() => summarize({ physicalRows: [physical("parent", 1, false), physical("parent", 1, false)] }), /deduplicated/u);
  assert.throws(() => summarize({ revisions: [revision("a", "parent", 10), revision("b", "a", 20), revision("c", "b", 30)] }));
  assert.throws(() => summarize({ revisions: [revision("child", "not-yet-created", 10)] }), /precede/u);
});

test("declarations bind fixed selection rules and exact analyzer source; omission cannot rescore history", async () => {
  const source = await readFile(new URL("./probe-recovery-measurement.mjs", import.meta.url));
  const declaration = recoveryMeasurementDeclaration(source);
  assert.deepEqual(assertRecoveryMeasurementDeclaration(declaration, source), declaration);
  assert.throws(() => assertRecoveryMeasurementDeclaration(undefined, source), /historical cohorts/u);
  assert.throws(() => assertRecoveryMeasurementDeclaration(declaration, Buffer.concat([source, Buffer.from("// changed")])), /exact loaded analyzer/u);
  for (const patch of [{ revised: "best-correct-output" }, { strictQualification: "ignore-failed-parents" }, { maximumBaselineRounds: 3 }, { trusted: true }]) {
    const body = { ...declaration, ...patch }; delete body.digest;
    assert.throws(() => assertRecoveryMeasurementDeclaration({ ...body, digest: qualificationDigest(body) }, source), /fixed selection rules/u);
  }
});

test("a read after replay cannot substitute a foreign Record or change its bound ledger prefix", async () => {
  const { verifyEventChain } = await import("../packages/core/dist/index.js");
  const fixture = JSON.parse(await readFile(new URL("../packages/runtime/test/fixtures/execution-revision-proof.json", import.meta.url), "utf8"));
  const events = fixture.events;
  const record = { eventHeadDigest: events.at(-1).eventDigest, caseDigest: events[0].caseDigest, runDigest: events[0].runDigest };
  const checked = { recordDigest: qualificationDigest(record) };
  assert.deepEqual(assertRecoveryTraceBinding(checked, record, events, verifyEventChain), events);
  assert.throws(() => assertRecoveryTraceBinding(checked, { ...record, runDigest: qualificationDigest("foreign") }, events, verifyEventChain), /authenticated qualification Record/u);
  const changed = structuredClone(events); changed[0].observedAt = "2026-09-06T00:00:00.000Z";
  assert.throws(() => assertRecoveryTraceBinding(checked, record, changed, verifyEventChain));
  assert.throws(() => assertRecoveryTraceBinding(checked, record, events.slice(0, -1), verifyEventChain), /signed Record prefix/u);
});

function manifest(recoveryMeasurement) {
  const config = { protocol: "jevyr.live-model-qualification-config/1", providers: [{ id: "mind.qualification.fixture", model: "fixture:1", modelFamily: "fixture",
    modelDigest: `sha256:${"a".repeat(64)}`, baseUrl: "http://127.0.0.1:11434/v1", investigationTransport: "native" }], seeds: ["b".repeat(64)], repeats: 1, dockerImage: "node:24-alpine" };
  const corpus = liveModelCorpus(), implementationBody = { protocol: "test-only/1" };
  const planned = corpus.cases.map((entry, index) => { const identity = { providerId: config.providers[0].id, seed: config.seeds[0], repeat: 0, caseKey: entry.caseKey };
    return { ...identity, attemptId: qualificationDigest(identity).slice(7, 31), directory: `attempt-${String(index + 1).padStart(3, "0")}` }; });
  const body = { protocol: "jevyr.live-model-qualification/1", config, corpus, planned, implementation: { ...implementationBody, digest: qualificationDigest(implementationBody) },
    ...(recoveryMeasurement ? { recoveryMeasurement } : {}) };
  return { ...body, digest: qualificationDigest(body) };
}
test("the public offline reader refuses missing or replaced declaration archives before reading any result", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-recovery-declaration-"));
  try {
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest()));
    await assert.rejects(verifyProbeRecovery(root), /historical cohorts/u);
    const declaration = recoveryMeasurementDeclaration(await readFile(new URL("./probe-recovery-measurement.mjs", import.meta.url)));
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest(declaration)));
    await writeFile(join(root, RECOVERY_ANALYZER_ARCHIVE), "throw new Error('Archived code must never execute');");
    await assert.rejects(verifyProbeRecovery(root));
  } finally {
    const relativeRoot = relative(resolve(tmpdir()), resolve(root));
    assert.ok(relativeRoot && !relativeRoot.startsWith("..") && !isAbsolute(relativeRoot));
    await rm(root, { recursive: true, force: true });
  }
});
