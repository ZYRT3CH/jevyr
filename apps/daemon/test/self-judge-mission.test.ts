import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { DEFAULT_SELF_JUDGE_MISSION, assertSelfJudgeMission, createSelfJudgeMission, loadSelfJudgeMission } from "../src/self-judge-mission.js";
import { RepositorySelfJudge, selfJudgeOptions } from "../src/self-judge.js";

const body = { protocol: "jevyr.self-judge-mission/1", impulse: "Check the captured repository. Success means `node repository.test.mjs` exits with code 0.", constraints: ["The assay must execute the captured repository tests."], requestedAssays: ["repository-check"] };
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-self-mission-"));
  try { await run(root); } finally { const inside = relative(resolve(tmpdir()), resolve(root)); assert.ok(inside.startsWith("jevyr-self-mission-") && !inside.includes(sep)); await rm(root, { recursive: true, force: true }); }
}

test("self-judge missions admit only bounded mission text and presealed assay requests", () => {
  const mission = createSelfJudgeMission(body); assertSelfJudgeMission(mission);
  assert.ok(Object.isFrozen(mission) && Object.isFrozen(mission.constraints) && Object.isFrozen(mission.requestedAssays));
  for (const field of ["subjects", "privacy", "control", "seed", "capabilities", "command", "digest"]) assert.throws(() => createSelfJudgeMission({ ...body, [field]: "injected" }), /exactly/);
  for (const patch of [{ impulse: "" }, { impulse: "x".repeat(32769) }, { constraints: ["bad\0text"] }, { requestedAssays: Array(33).fill("assay") }, { constraints: Array(32).fill("界".repeat(4096)) }]) assert.throws(() => createSelfJudgeMission({ ...body, ...patch }), /finite|ceiling/);
  assert.throws(() => assertSelfJudgeMission({ ...mission, impulse: "Changed after digest" }), /digest/);
  let read = false; const getter = { ...body }; Object.defineProperty(getter, "impulse", { enumerable: true, get() { read = true; return body.impulse; } });
  assert.throws(() => createSelfJudgeMission(getter), /exactly/); assert.equal(read, false);
});

test("the configured mission is an immutable startup capture and disabled watchers do not read it", async () => fixture(async root => {
  const file = join(root, "mission.json"); await writeFile(file, JSON.stringify(body));
  const env = { JEVYR_SELF_JUDGE: "1", JEVYR_SELF_JUDGE_CASE_FILE: "mission.json" };
  const loaded = selfJudgeOptions(env, root).mission!;
  await writeFile(file, JSON.stringify({ ...body, impulse: "Changed mission" }));
  assert.equal(loaded.impulse, body.impulse); assert.notEqual(loadSelfJudgeMission(env, root).digest, loaded.digest);
  assert.equal(selfJudgeOptions({ JEVYR_SELF_JUDGE_CASE_FILE: "absent.json" }, root).mission!.digest, DEFAULT_SELF_JUDGE_MISSION.digest);
  await writeFile(file, '{"protocol":"jevyr.self-judge-mission/1","impulse":"first","impulse":"second","constraints":[],"requestedAssays":[]}');
  assert.throws(() => loadSelfJudgeMission(env, root), /duplicate/i);
  await writeFile(file, Buffer.from([0xff, 0xfe])); assert.throws(() => loadSelfJudgeMission(env, root), /UTF|JSON/i);
  await writeFile(file, " ".repeat(128 * 1024 + 1)); assert.throws(() => loadSelfJudgeMission(env, root), /bounded/);
}));

test("mission file aliases and escaping relative broker paths are refused", async () => fixture(async root => {
  const file = join(root, "mission.json"); await writeFile(file, JSON.stringify(body));
  const project = join(root, "project"); await mkdir(project);
  assert.throws(() => loadSelfJudgeMission({ JEVYR_SELF_JUDGE_CASE_FILE: "../mission.json" }, project), /escaped/);
  assert.equal(loadSelfJudgeMission({ JEVYR_SELF_JUDGE_CASE_FILE: file }, project).impulse, body.impulse);
  await link(file, join(root, "alias.json")); assert.throws(() => loadSelfJudgeMission({ JEVYR_SELF_JUDGE_CASE_FILE: file }, root), /non-aliased/);
}));

test("a finite mission binds the snapshot and command obligation while the driver owns all Case authority fields", async () => fixture(async root => {
  await mkdir(join(root, ".jevyr")); await writeFile(join(root, "repository.test.mjs"), "process.exit(9);\n");
  const original = createSelfJudgeMission(body);
  const supplied = { ...original, constraints: [...original.constraints], requestedAssays: [...original.requestedAssays] };
  let manifestDigest = "", calls = 0;
  const watcher = new RepositorySelfJudge({ ...selfJudgeOptions({ JEVYR_SELF_JUDGE: "1" }, root), mission: supplied }, {
    proposeOffspring: async () => { assert.fail("UNPROVEN does not authorize offspring"); },
    runCase: async ({ submission, manifest }) => {
      calls++; manifestDigest = manifest.digest;
      assert.equal(manifest.protocol, "jevyr.repository-self-snapshot/2"); assert.equal(manifest.missionDigest, original.digest);
      assert.equal(submission.case.impulse, body.impulse); assert.equal(submission.case.control, "sovereign"); assert.equal(submission.case.privacy, "local_only"); assert.match(submission.case.seed!, /^[a-f0-9]{64}$/u);
      assert.deepEqual(submission.case.requestedAssays, body.requestedAssays); assert.equal(submission.case.constraints!.at(-1), body.constraints[0]);
      const source = submission.case.subjects!.find(item => item.id === "own-repository")!;
      assert.equal(await readFile(join(source.locator, "repository.test.mjs"), "utf8"), "process.exit(9);\n");
      const contract = compileIntentContract({ impulse: submission.case.impulse, constraints: submission.case.constraints, requestedAssays: submission.case.requestedAssays, subjectIds: [source.id] });
      assert.ok(contract.criticalObligations.some(item => item.oracle?.kind === "command_exit_code" && item.oracle.operand === "node repository.test.mjs" && item.oracle.expected === "0"));
      return { caseId: "case_0123456789abcdef", runDigest: `sha256:${"a".repeat(64)}`, proofVerified: true, integrity: "VALID", judgment: "UNPROVEN", bindingFailures: [] };
    },
  });
  supplied.impulse = "Mutated caller text"; supplied.constraints[0] = "Mutated caller list";
  assert.equal((await watcher.tick()).status, "judged"); assert.equal((await watcher.tick()).status, "unchanged"); assert.equal(calls, 1); await watcher.stop();
  const differentMission = createSelfJudgeMission({ ...body, constraints: [...body.constraints, "Preserve all source bytes."] });
  const changed = new RepositorySelfJudge({ ...selfJudgeOptions({ JEVYR_SELF_JUDGE: "1" }, root), mission: differentMission }, { proposeOffspring: async () => {}, runCase: async ({ manifest }) => {
    assert.notEqual(manifest.digest, manifestDigest); assert.equal(manifest.missionDigest, differentMission.digest);
    return { caseId: "case_1123456789abcdef", runDigest: `sha256:${"b".repeat(64)}`, proofVerified: true, integrity: "VALID", bindingFailures: [] };
  } });
  assert.equal((await changed.tick()).status, "judged"); await changed.stop();
}));
