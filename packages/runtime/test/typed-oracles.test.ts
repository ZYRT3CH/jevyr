import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntentObligation, IntentOracle } from "@jevyr/protocol";
import { exactByteCapture } from "../src/evidence-artifacts.js";
import {
  evaluateForgeOracle,
  parseStrictOracleCommand,
  type ForgeExecutionObservation,
  type ForgeOracleObservation,
  type SealedForgeOraclePlan,
} from "../src/typed-oracles.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

function obligation(oracle: IntentOracle, id = `obl_${oracle.kind}`): IntentObligation {
  return {
    id,
    statement: `Mechanically test ${oracle.kind}.`,
    origin: "impulse",
    critical: true,
    assayability: "ASSAYABLE",
    oracle,
  };
}

function planFor(target: IntentObligation, overrides: Partial<SealedForgeOraclePlan> = {}): SealedForgeOraclePlan {
  return {
    tool: "forge.command",
    obligationId: target.id,
    command: "node",
    args: ["check.js"],
    shell: false,
    ...overrides,
  };
}

function execution(overrides: Partial<ForgeExecutionObservation> = {}): ForgeExecutionObservation {
  const stdout = Object.hasOwn(overrides, "stdout") ? overrides.stdout : "";
  const stderr = Object.hasOwn(overrides, "stderr") ? overrides.stderr : "";
  return {
    state: "exited",
    mode: "docker",
    command: "node",
    args: ["check.js"],
    shell: false,
    exitCode: 0,
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
    stdoutCapture: overrides.stdoutCapture ?? exactByteCapture(Buffer.from(stdout ?? "", "utf8")),
    stderrCapture: overrides.stderrCapture ?? exactByteCapture(Buffer.from(stderr ?? "", "utf8")),
    outputTruncated: false,
    ...overrides,
  };
}

function observation(overrides: Partial<ForgeOracleObservation> = {}): ForgeOracleObservation {
  return { execution: execution(), ...overrides };
}

test("strict command grammar tokenizes argv but rejects shell semantics", () => {
  assert.deepEqual(parseStrictOracleCommand("pnpm test --filter core"), ["pnpm", "test", "--filter", "core"]);
  assert.deepEqual(parseStrictOracleCommand("node 'file name.js'"), ["node", "file name.js"]);
  assert.equal(parseStrictOracleCommand("pnpm test && curl example.test"), undefined);
  assert.equal(parseStrictOracleCommand("node $(payload)"), undefined);
  assert.equal(parseStrictOracleCommand("node 'unterminated"), undefined);
});

test("command-exit proof requires exact oracle, plan, and observed no-shell argv", () => {
  const target = obligation({ kind: "command_exit_code", operand: "pnpm test", operator: "equals", expected: "0" });

  const mismatchedPlan = planFor(target, { command: "npm", args: ["test"] });
  assert.deepEqual(evaluateForgeOracle(target, mismatchedPlan, observation({
    execution: execution({ command: "npm", args: ["test"] }),
  })).status, "BLOCKED");

  const exactPlan = planFor(target, { command: "pnpm", args: ["test"] });
  assert.equal(evaluateForgeOracle(target, exactPlan, observation({
    execution: execution({ command: "pnpm", args: ["test"], exitCode: 0 }),
  })).status, "PASSED");

  const failure = evaluateForgeOracle(target, exactPlan, observation({
    execution: execution({ command: "pnpm", args: ["test"], exitCode: 2 }),
  }));
  assert.equal(failure.status, "FAILED");
  assert.equal(failure.decisive, true);

  assert.equal(evaluateForgeOracle(target, exactPlan, observation({
    execution: execution({ command: "pnpm", args: ["different"], exitCode: 0 }),
  })).status, "BLOCKED");
});

test("exit zero with the wrong output is decisive failure, never generic proof", () => {
  const target = obligation({ kind: "exact_output", operand: "result", operator: "equals", expected: "\"approved\"" });
  const plan = planFor(target);
  const wrong = evaluateForgeOracle(target, plan, observation({
    execution: execution({ exitCode: 0, stdout: "almost approved" }),
  }));
  assert.equal(wrong.status, "FAILED");
  assert.equal(wrong.decisive, true);

  assert.equal(evaluateForgeOracle(target, plan, observation({
    execution: execution({ exitCode: 0, stdout: "approved" }),
  })).status, "PASSED");

  assert.equal(evaluateForgeOracle(target, plan, observation({
    execution: execution({ exitCode: 0, stdout: "approved", outputTruncated: true }),
  })).status, "BLOCKED");
});

test("JSON parsing evaluates complete bytes instead of the process exit label", () => {
  const target = obligation({ kind: "output_parse", operand: "result", operator: "parses_as", expected: "application/json" });
  const plan = planFor(target);
  assert.equal(evaluateForgeOracle(target, plan, observation({
    execution: execution({ exitCode: 7, stdout: "{\"answer\":42}" }),
  })).status, "PASSED");
  assert.equal(evaluateForgeOracle(target, plan, observation({
    execution: execution({ exitCode: 0, stdout: "{answer:42}" }),
  })).status, "FAILED");
  assert.equal(evaluateForgeOracle(target, plan, observation({
    execution: execution({ exitCode: 0, stdout: '{"answer":41,"\\u0061nswer":42}' }),
  })).status, "FAILED");
});

test("text oracles reject invalid or incomplete bytes while command-exit remains usable", () => {
  const invalid = exactByteCapture(Uint8Array.from([0x80]));
  const empty = exactByteCapture(new Uint8Array());
  const exact = obligation({ kind: "exact_output", operand: "result", operator: "equals", expected: "\"approved\"" });
  const json = obligation({ kind: "output_parse", operand: "result", operator: "parses_as", expected: "application/json" });
  const command = obligation({ kind: "command_exit_code", operand: "node check.js", operator: "equals", expected: "0" });
  const invalidExecution = execution({
    stdout: undefined,
    stdoutCapture: invalid,
    stderrCapture: empty,
  });
  assert.equal(evaluateForgeOracle(exact, planFor(exact), observation({ execution: invalidExecution })).status, "BLOCKED");
  assert.equal(evaluateForgeOracle(json, planFor(json), observation({ execution: invalidExecution })).status, "BLOCKED");
  assert.equal(evaluateForgeOracle(command, planFor(command), observation({ execution: invalidExecution })).status, "PASSED");

  const partial = exactByteCapture(Buffer.from("a", "utf8"), 2);
  assert.equal(evaluateForgeOracle(exact, planFor(exact), observation({
    execution: execution({ stdout: "a", stdoutCapture: partial, outputTruncated: true }),
  })).status, "BLOCKED");
});

test("path existence uses only a complete, bounded, normalized workspace manifest", () => {
  const target = obligation({ kind: "path_exists", operand: "dist/result.json", operator: "exists", expected: "true" });
  const plan = planFor(target);
  const present = observation({
    workspace: {
      root: "disposable-workspace",
      complete: true,
      maxEntries: 20,
      entries: [
        { path: "dist", kind: "directory" },
        { path: "dist/result.json", kind: "file", byteLength: 2, digest: DIGEST_A },
      ],
    },
  });
  assert.equal(evaluateForgeOracle(target, plan, present).status, "PASSED");

  assert.equal(evaluateForgeOracle(target, plan, observation({
    workspace: { root: "disposable-workspace", complete: true, maxEntries: 20, entries: [] },
  })).status, "FAILED");

  const traversal = obligation({ kind: "path_exists", operand: "../outside", operator: "exists", expected: "true" });
  assert.equal(evaluateForgeOracle(traversal, planFor(traversal), present).status, "BLOCKED");

  assert.equal(evaluateForgeOracle(target, plan, observation({
    workspace: {
      root: "disposable-workspace",
      complete: true,
      maxEntries: 20,
      entries: [{ path: "../forged", kind: "file", byteLength: 1, digest: DIGEST_A }],
    },
  })).status, "BLOCKED");
});

test("trusted-host networkDenied claims cannot prove network isolation", () => {
  const target = obligation({ kind: "network_access_count", operand: "forge", operator: "equals", expected: "0" });
  const plan = planFor(target);
  const networkIsolation = {
    schema: "jevyr.docker-network-none/1" as const,
    networkMode: "none" as const,
    enforced: true,
    complete: true,
    externalAccessCount: 0,
  };
  assert.equal(evaluateForgeOracle(target, plan, observation({
    execution: execution({ mode: "trusted-host" }),
    networkIsolation,
  })).status, "BLOCKED");

  assert.equal(evaluateForgeOracle(target, plan, observation({ networkIsolation })).status, "PASSED");
});

test("sealed subject proof requires Docker plus the exact sanitized read-only boundary digest", () => {
  const target = obligation({
    kind: "sealed_subject_digest",
    operand: "sealed_subjects",
    operator: "unchanged",
    expected: "sealed_snapshot",
  });
  const plan = planFor(target, { sealedSubjectDigest: DIGEST_A });
  const boundary = {
    schema: "jevyr.sanitized-subject-boundary/2" as const,
    sanitized: true,
    disposableWorkspace: true,
    sealedSubjectReadOnly: true,
    originalSubjectAccessible: false,
    complete: true,
    captureDigest: DIGEST_A,
    materializationDigest: DIGEST_B,
    beforeDigest: DIGEST_C,
    afterDigest: DIGEST_C,
  };
  assert.equal(evaluateForgeOracle(target, plan, observation({ subjectBoundary: boundary })).status, "PASSED");

  assert.equal(evaluateForgeOracle(target, plan, observation({
    subjectBoundary: { ...boundary, afterDigest: DIGEST_B },
  })).status, "FAILED");

  assert.equal(evaluateForgeOracle(target, plan, observation({
    subjectBoundary: { ...boundary, captureDigest: DIGEST_B },
  })).status, "BLOCKED");

  assert.equal(evaluateForgeOracle(target, plan, observation({
    execution: execution({ mode: "trusted-host" }),
    subjectBoundary: boundary,
  })).status, "BLOCKED");
});

test("sealed suites stay blocked without a bound typed report and accept a concrete one", () => {
  const target = obligation({
    kind: "sealed_test_suite",
    operand: "sealed_subject_test_suite",
    operator: "passes",
    expected: "zero_failures",
  });
  const genericPlan = planFor(target);
  assert.equal(evaluateForgeOracle(target, genericPlan, observation()).status, "BLOCKED");

  const plan = planFor(target, { sealedTestSuite: { suiteDigest: DIGEST_A } });
  const report = {
    schema: "jevyr.test-suite-result/1" as const,
    complete: true,
    suiteDigest: DIGEST_A,
    reportDigest: DIGEST_B,
    total: 3,
    passed: 2,
    failed: 0,
    errors: 0,
    skipped: 1,
  };
  assert.equal(evaluateForgeOracle(target, plan, observation({ testSuite: report })).status, "PASSED");
  assert.equal(evaluateForgeOracle(target, plan, observation({
    testSuite: { ...report, passed: 1, failed: 1 },
  })).status, "FAILED");
});

test("generic requested assays remain blocked; only an exactly bound typed evaluator can decide", () => {
  const target = obligation({
    kind: "requested_assay",
    operand: "Make it feel excellent",
    operator: "passes",
    expected: "pass",
  }, "obl_requested");
  assert.equal(evaluateForgeOracle(target, planFor(target), observation()).status, "BLOCKED");

  const plan = planFor(target, {
    requestedAssay: { definitionDigest: DIGEST_A, evaluatorDigest: DIGEST_B },
  });
  const evidence = {
    schema: "jevyr.requested-assay-result/1" as const,
    complete: true,
    definitionDigest: DIGEST_A,
    evaluatorDigest: DIGEST_B,
    evidenceDigest: DIGEST_C,
    outcome: "pass" as const,
  };
  assert.equal(evaluateForgeOracle(target, plan, observation({ requestedAssay: evidence })).status, "PASSED");
  assert.equal(evaluateForgeOracle(target, plan, observation({
    requestedAssay: { ...evidence, evaluatorDigest: DIGEST_C },
  })).status, "BLOCKED");
});

test("unassayable obligations and incomplete executions are never decisive", () => {
  const target: IntentObligation = {
    id: "obl_unassayable",
    statement: "Be transcendent.",
    origin: "impulse",
    critical: true,
    assayability: "UNASSAYABLE",
    unassayableReason: "No finite oracle.",
  };
  const blocked = evaluateForgeOracle(target, planFor(target), observation());
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.decisive, false);

  const command = obligation({ kind: "command_exit_code", operand: "node check.js", operator: "equals", expected: "0" });
  const timedOut = evaluateForgeOracle(command, planFor(command), observation({
    execution: execution({ state: "timed-out" }),
  }));
  assert.equal(timedOut.status, "BLOCKED");
  assert.equal(timedOut.decisive, false);
});
