import type { IntentObligation, IntentOracle } from "@jevyr/protocol";
import { parseJsonText } from "@jevyr/core";
import { normalizeJevyrRelativePath } from "./ignore-policy.js";
import { decodeExactByteCapture } from "./evidence-artifacts.js";

export const MAX_ORACLE_COMMAND_BYTES = 8_192;
// Base64 evidence for a full stream must still fit inside Bone's 2 MiB
// canonical ToolObservation envelope together with its typed execution proof.
export const MAX_ORACLE_OUTPUT_BYTES = 1_000_000;
export const MAX_ORACLE_WORKSPACE_ENTRIES = 10_000;
export const MAX_ORACLE_PATH_BYTES = 4_096;
export const MAX_ORACLE_FILE_BYTES = 20_000_000;

export type ForgeOracleStatus = "PASSED" | "FAILED" | "BLOCKED";

/**
 * One byte-for-byte process stream capture. `data` is canonical RFC 4648
 * base64 for the retained bytes; the digest commits to those decoded bytes.
 * A capture is complete exactly when every observed byte was retained.
 */
export interface ExactByteCapture {
  readonly schema: "jevyr.exact-byte-capture/1";
  readonly encoding: "base64";
  readonly data: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly observedByteLength: number;
  readonly complete: boolean;
  readonly utf8: "valid" | "invalid";
}

export interface SealedTestSuitePlan {
  /** Digest of the concrete test suite that was fixed before Cast. */
  readonly suiteDigest: string;
}

export interface RequestedAssayPlan {
  /** Digest of a machine-readable assay definition fixed before Cast. */
  readonly definitionDigest: string;
  /** Digest of the exact deterministic evaluator fixed before Cast. */
  readonly evaluatorDigest: string;
}

/**
 * The small, immutable part of a Forge plan needed by the oracle evaluator.
 * Callers must source this from the sealed policy, never from model output.
 */
export interface SealedForgeOraclePlan {
  readonly tool: "forge.command";
  readonly obligationId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: false;
  /** Aggregate digest of the sanitized subject snapshot bound at Seal. */
  readonly sealedSubjectDigest?: string;
  readonly sealedTestSuite?: SealedTestSuitePlan;
  readonly requestedAssay?: RequestedAssayPlan;
}

export interface ForgeExecutionObservation {
  readonly state: "exited" | "timed-out" | "not-executed";
  readonly mode: "docker" | "trusted-host" | "observe-only";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly shell?: boolean;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutCapture?: ExactByteCapture;
  readonly stderrCapture?: ExactByteCapture;
  readonly outputTruncated?: boolean;
  /** Docker-only proof that the command selected the startup-sealed content ID. */
  readonly substrate?: DockerExecutionSubstrateEvidence;
}

export interface DockerExecutionSubstrateEvidence {
  readonly schema: "jevyr.docker-execution-substrate/1";
  readonly requestedReference: string;
  readonly startupResolvedImageId: string;
  readonly executionImageId: string;
  readonly contentAddressed: true;
  readonly inspectedBeforeExecution: true;
}

export interface WorkspacePathMetadata {
  readonly path: string;
  readonly kind: "file" | "directory";
  /** Files require both bounded size and a content digest. */
  readonly byteLength?: number;
  readonly digest?: string;
}

export interface BoundedWorkspaceManifest {
  readonly root: "disposable-workspace";
  readonly complete: boolean;
  readonly maxEntries: number;
  readonly entries: readonly WorkspacePathMetadata[];
}

export interface DockerNetworkIsolationEvidence {
  readonly schema: "jevyr.docker-network-none/1";
  readonly networkMode: "none";
  readonly enforced: boolean;
  readonly complete: boolean;
  /** An enforced Docker `none` namespace can only attest zero external accesses. */
  readonly externalAccessCount: number;
}

export interface SubjectBoundaryEvidence {
  readonly schema: "jevyr.sanitized-subject-boundary/2";
  readonly sanitized: boolean;
  readonly disposableWorkspace: boolean;
  readonly sealedSubjectReadOnly: boolean;
  readonly originalSubjectAccessible: boolean;
  readonly complete: boolean;
  /** Case-level private-CAS capture commitment; this is not a tree digest. */
  readonly captureDigest: string;
  /** Commitment to the synthetic subject layout reconstructed for this cell. */
  readonly materializationDigest: string;
  /** Digests of the actual dedicated tree observed around Docker execution. */
  readonly beforeDigest: string;
  readonly afterDigest: string;
}

export interface SealedTestSuiteEvidence {
  readonly schema: "jevyr.test-suite-result/1";
  readonly complete: boolean;
  readonly suiteDigest: string;
  readonly reportDigest: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly skipped: number;
}

export interface RequestedAssayEvidence {
  readonly schema: "jevyr.requested-assay-result/1";
  readonly complete: boolean;
  readonly definitionDigest: string;
  readonly evaluatorDigest: string;
  readonly evidenceDigest: string;
  readonly outcome: "pass" | "fail";
}

/** Typed evidence only; free-form summaries and generic success flags are absent by design. */
export interface ForgeOracleObservation {
  readonly execution: ForgeExecutionObservation;
  /** Present only for the distinct scratch-only material protocol. It conveys
   * no candidate identity, assertion truth or evidence authority. */
  readonly toolingWorkspace?: Readonly<{ schema: "jevyr.empty-tooling-workspace/1"; initialEntries: 0; initialDigest: string }>;
  readonly workspace?: BoundedWorkspaceManifest;
  readonly networkIsolation?: DockerNetworkIsolationEvidence;
  readonly subjectBoundary?: SubjectBoundaryEvidence;
  readonly testSuite?: SealedTestSuiteEvidence;
  readonly requestedAssay?: RequestedAssayEvidence;
}

export interface ForgeOracleEvaluation {
  readonly obligationId: string;
  readonly oracleKind?: IntentOracle["kind"];
  readonly status: ForgeOracleStatus;
  readonly decisive: boolean;
  readonly reason: string;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const UNSAFE_COMMAND_PATTERN = /[\0\r\n|&;<>`$%*?\[\]{}()!]/u;

function result(
  obligationId: string,
  oracleKind: IntentOracle["kind"] | undefined,
  status: ForgeOracleStatus,
  reason: string,
): ForgeOracleEvaluation {
  return Object.freeze({
    obligationId,
    ...(oracleKind === undefined ? {} : { oracleKind }),
    status,
    decisive: status !== "BLOCKED",
    reason,
  });
}

function blocked(obligation: IntentObligation, reason: string): ForgeOracleEvaluation {
  return result(obligation.id, obligation.oracle?.kind, "BLOCKED", reason);
}

function passed(obligation: IntentObligation, reason: string): ForgeOracleEvaluation {
  return result(obligation.id, obligation.oracle?.kind, "PASSED", reason);
}

function failed(obligation: IntentObligation, reason: string): ForgeOracleEvaluation {
  return result(obligation.id, obligation.oracle?.kind, "FAILED", reason);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validDigest(value: string | undefined): value is string {
  return value !== undefined && SHA256_PATTERN.test(value);
}

function validNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parses a deliberately finite, no-shell command grammar. Quoting only groups
 * literal text; expansion, redirection, pipelines, globs, and control syntax
 * are rejected instead of guessed across shell dialects.
 */
export function parseStrictOracleCommand(operand: string): readonly string[] | undefined {
  if (
    operand.length === 0 ||
    Buffer.byteLength(operand, "utf8") > MAX_ORACLE_COMMAND_BYTES ||
    UNSAFE_COMMAND_PATTERN.test(operand)
  ) {
    return undefined;
  }

  const argv: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | "\"" | undefined;
  for (const character of operand) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        argv.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (tokenStarted) argv.push(token);
  if (argv.length === 0 || argv[0] === "") return undefined;
  return Object.freeze(argv);
}

function validateExecution(
  obligation: IntentObligation,
  plan: SealedForgeOraclePlan,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation | undefined {
  if (plan.obligationId !== obligation.id) {
    return blocked(obligation, "The Forge plan is not bound to this sealed obligation.");
  }
  if (plan.shell !== false) {
    return blocked(obligation, "The Forge plan does not prohibit shell interpretation.");
  }
  const execution = observation.execution;
  if (execution.state !== "exited") {
    return blocked(obligation, "The Forge did not produce a completed process exit.");
  }
  if (execution.shell !== false) {
    return blocked(obligation, "The observed command used or may have used a shell.");
  }
  if (execution.command !== plan.command || execution.args === undefined || !equalStrings(execution.args, plan.args)) {
    return blocked(obligation, "The executed argv does not match the sealed Forge plan.");
  }
  if (!Number.isSafeInteger(execution.exitCode)) {
    return blocked(obligation, "The Forge observation has no bounded integer exit code.");
  }
  return undefined;
}

function boundedOutput(observation: ForgeOracleObservation): Readonly<{ bytes: Uint8Array; text: string }> | undefined {
  const { execution } = observation;
  if (execution.outputTruncated !== false || execution.stdoutCapture === undefined) return undefined;
  try {
    const captured = decodeExactByteCapture(execution.stdoutCapture);
    if (!execution.stdoutCapture.complete
      || execution.stdoutCapture.observedByteLength > MAX_ORACLE_OUTPUT_BYTES
      || captured.text === undefined
      || (execution.stdout !== undefined && execution.stdout !== captured.text)) return undefined;
    return Object.freeze({ bytes: captured.bytes, text: captured.text });
  } catch {
    return undefined;
  }
}

function expectedExactOutput(expected: string): string | undefined {
  if (expected.startsWith("\"") && expected.endsWith("\"")) {
    try {
      const decoded: unknown = parseJsonText(expected, "Sealed JSON oracle expectation");
      return typeof decoded === "string" ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  if (expected.startsWith("'") && expected.endsWith("'") && expected.length >= 2) {
    const inner = expected.slice(1, -1);
    if (inner.includes("'") || /[\r\n\0]/u.test(inner)) return undefined;
    return inner;
  }
  return /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?|true|false|null)$/u.test(expected)
    ? expected
    : undefined;
}

function validateWorkspaceManifest(manifest: BoundedWorkspaceManifest | undefined): string | undefined {
  if (manifest === undefined) return "No workspace manifest was observed.";
  if (manifest.root !== "disposable-workspace" || manifest.complete !== true) {
    return "The workspace manifest is not a complete disposable-workspace manifest.";
  }
  if (
    !Number.isSafeInteger(manifest.maxEntries) ||
    manifest.maxEntries < 1 ||
    manifest.maxEntries > MAX_ORACLE_WORKSPACE_ENTRIES ||
    manifest.entries.length > manifest.maxEntries
  ) {
    return "The workspace manifest exceeds its bounded entry envelope.";
  }
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    let normalized: string;
    try {
      normalized = normalizeJevyrRelativePath(entry.path);
    } catch {
      return "The workspace manifest contains an unsafe path.";
    }
    if (
      normalized !== entry.path ||
      Buffer.byteLength(normalized, "utf8") > MAX_ORACLE_PATH_BYTES ||
      paths.has(normalized)
    ) {
      return "The workspace manifest contains an ambiguous, oversized, or duplicate path.";
    }
    paths.add(normalized);
    if (entry.kind === "file") {
      if (
        entry.byteLength === undefined ||
        !validNonnegativeInteger(entry.byteLength) ||
        entry.byteLength > MAX_ORACLE_FILE_BYTES ||
        !validDigest(entry.digest)
      ) {
        return "The workspace manifest contains unbounded or unbound file metadata.";
      }
    } else if (entry.kind !== "directory") {
      return "The workspace manifest contains an unsupported entry kind.";
    }
  }
  return undefined;
}

function evaluateCommandExitCode(
  obligation: IntentObligation,
  oracle: IntentOracle,
  plan: SealedForgeOraclePlan,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  if (oracle.operator !== "equals" || !/^-?\d+$/u.test(oracle.expected)) {
    return blocked(obligation, "The command-exit oracle has an unsupported operator or expected value.");
  }
  const expectedArgv = parseStrictOracleCommand(oracle.operand);
  if (expectedArgv === undefined) {
    return blocked(obligation, "The sealed command is outside Jevyr's finite no-shell grammar.");
  }
  if (!equalStrings(expectedArgv, [plan.command, ...plan.args])) {
    return blocked(obligation, "The sealed command oracle and Forge plan name different argv.");
  }
  const expectedExit = Number(oracle.expected);
  if (!Number.isSafeInteger(expectedExit)) {
    return blocked(obligation, "The command-exit oracle expects an unsafe integer.");
  }
  return observation.execution.exitCode === expectedExit
    ? passed(obligation, `The exact sealed argv exited with ${expectedExit}.`)
    : failed(obligation, `The exact sealed argv exited with ${observation.execution.exitCode as number}, not ${expectedExit}.`);
}

function evaluateExactOutput(
  obligation: IntentObligation,
  oracle: IntentOracle,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  if (oracle.operand !== "result" || oracle.operator !== "equals") {
    return blocked(obligation, "The exact-output oracle has an unsupported operand or operator.");
  }
  const expected = expectedExactOutput(oracle.expected);
  if (expected === undefined) {
    return blocked(obligation, "The exact-output oracle does not contain a supported sealed literal.");
  }
  const output = boundedOutput(observation);
  if (output === undefined) {
    return blocked(obligation, "Exact output bytes are unavailable, truncated, invalid UTF-8, or outside the output bound.");
  }
  return Buffer.from(output.bytes).equals(Buffer.from(expected, "utf8"))
    ? passed(obligation, "The complete stdout bytes equal the sealed literal.")
    : failed(obligation, "The complete stdout bytes do not equal the sealed literal.");
}

function evaluateOutputParse(
  obligation: IntentObligation,
  oracle: IntentOracle,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  if (oracle.operand !== "result" || oracle.operator !== "parses_as" || oracle.expected !== "application/json") {
    return blocked(obligation, "The output-parse oracle is not the supported JSON oracle.");
  }
  const output = boundedOutput(observation);
  if (output === undefined) {
    return blocked(obligation, "JSON output bytes are unavailable, truncated, invalid UTF-8, or outside the output bound.");
  }
  try {
    parseJsonText(output.text, "Forge JSON output");
    return passed(obligation, "The complete stdout is syntactically valid JSON.");
  } catch {
    return failed(obligation, "The complete stdout is not syntactically valid JSON.");
  }
}

function evaluatePathExists(
  obligation: IntentObligation,
  oracle: IntentOracle,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  if (oracle.operator !== "exists" || oracle.expected !== "true") {
    return blocked(obligation, "The path oracle has an unsupported operator or expected value.");
  }
  let expectedPath: string;
  try {
    expectedPath = normalizeJevyrRelativePath(oracle.operand);
  } catch {
    return blocked(obligation, "The sealed path is absolute, traversing, or otherwise unsafe.");
  }
  if (expectedPath !== oracle.operand || Buffer.byteLength(expectedPath, "utf8") > MAX_ORACLE_PATH_BYTES) {
    return blocked(obligation, "The sealed path is not in canonical bounded workspace form.");
  }
  const problem = validateWorkspaceManifest(observation.workspace);
  if (problem !== undefined) return blocked(obligation, problem);
  const exists = observation.workspace?.entries.some((entry) => entry.path === expectedPath) === true;
  return exists
    ? passed(obligation, "The canonical path is present in the complete bounded workspace manifest.")
    : failed(obligation, "The canonical path is absent from the complete bounded workspace manifest.");
}

function evaluateNetworkAccessCount(
  obligation: IntentObligation,
  oracle: IntentOracle,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  if (oracle.operand !== "forge" || oracle.operator !== "equals" || !/^\d+$/u.test(oracle.expected)) {
    return blocked(obligation, "The network oracle has an unsupported operand, operator, or expected value.");
  }
  const evidence = observation.networkIsolation;
  if (
    observation.execution.mode !== "docker" ||
    evidence?.schema !== "jevyr.docker-network-none/1" ||
    evidence.networkMode !== "none" ||
    evidence.enforced !== true ||
    evidence.complete !== true ||
    evidence.externalAccessCount !== 0
  ) {
    return blocked(obligation, "Only an enforced Docker network-none boundary can prove network isolation.");
  }
  const expected = Number(oracle.expected);
  if (!validNonnegativeInteger(expected)) {
    return blocked(obligation, "The network oracle expects an unsafe count.");
  }
  return expected === evidence.externalAccessCount
    ? passed(obligation, "Docker network-none proves zero external network accesses.")
    : failed(obligation, `The enforced external access count is 0, not ${expected}.`);
}

function evaluateSealedSubjectDigest(
  obligation: IntentObligation,
  oracle: IntentOracle,
  plan: SealedForgeOraclePlan,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  if (oracle.operand !== "sealed_subjects" || oracle.operator !== "unchanged" || oracle.expected !== "sealed_snapshot") {
    return blocked(obligation, "The sealed-subject oracle has an unsupported operand, operator, or expected value.");
  }
  const evidence = observation.subjectBoundary;
  if (
    observation.execution.mode !== "docker" ||
    evidence?.schema !== "jevyr.sanitized-subject-boundary/2" ||
    evidence.sanitized !== true ||
    evidence.disposableWorkspace !== true ||
    evidence.sealedSubjectReadOnly !== true ||
    evidence.originalSubjectAccessible !== false ||
    evidence.complete !== true
  ) {
    return blocked(obligation, "The execution did not prove an exclusive sanitized disposable/read-only subject boundary.");
  }
  if (
    !validDigest(plan.sealedSubjectDigest) ||
    !validDigest(evidence.captureDigest) ||
    !validDigest(evidence.materializationDigest) ||
    !validDigest(evidence.beforeDigest) ||
    !validDigest(evidence.afterDigest) ||
    evidence.captureDigest !== plan.sealedSubjectDigest
  ) {
    return blocked(obligation, "The observed subject boundary is not bound to the sealed subject capture digest.");
  }
  return evidence.afterDigest === evidence.beforeDigest
    ? passed(obligation, "The dedicated reconstructed subject tree remained unchanged across the isolated execution.")
    : failed(obligation, "The dedicated reconstructed subject tree changed across the isolated execution.");
}

function validSuiteCounts(evidence: SealedTestSuiteEvidence): boolean {
  const counts = [evidence.total, evidence.passed, evidence.failed, evidence.errors, evidence.skipped];
  return counts.every(validNonnegativeInteger) &&
    evidence.total === evidence.passed + evidence.failed + evidence.errors + evidence.skipped;
}

function evaluateSealedTestSuite(
  obligation: IntentObligation,
  oracle: IntentOracle,
  plan: SealedForgeOraclePlan,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  if (
    oracle.operand !== "sealed_subject_test_suite" ||
    oracle.operator !== "passes" ||
    oracle.expected !== "zero_failures"
  ) {
    return blocked(obligation, "The sealed-test-suite oracle has an unsupported shape.");
  }
  const expected = plan.sealedTestSuite;
  const evidence = observation.testSuite;
  if (
    expected === undefined ||
    evidence?.schema !== "jevyr.test-suite-result/1" ||
    evidence.complete !== true ||
    !validDigest(expected.suiteDigest) ||
    evidence.suiteDigest !== expected.suiteDigest ||
    !validDigest(evidence.reportDigest) ||
    !validSuiteCounts(evidence)
  ) {
    return blocked(obligation, "No complete typed test report is bound to the sealed suite.");
  }
  if (evidence.failed > 0 || evidence.errors > 0) {
    return failed(obligation, `The sealed suite reports ${evidence.failed} failures and ${evidence.errors} errors.`);
  }
  if (evidence.passed === 0) {
    return blocked(obligation, "The sealed suite report contains no passing executed test.");
  }
  return passed(obligation, `The sealed suite reports ${evidence.passed} passing tests and zero failures or errors.`);
}

function evaluateRequestedAssay(
  obligation: IntentObligation,
  oracle: IntentOracle,
  plan: SealedForgeOraclePlan,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  if (oracle.operator !== "passes" || oracle.expected !== "pass") {
    return blocked(obligation, "The requested-assay oracle has an unsupported operator or expected value.");
  }
  const expected = plan.requestedAssay;
  const evidence = observation.requestedAssay;
  if (
    expected === undefined ||
    evidence?.schema !== "jevyr.requested-assay-result/1" ||
    evidence.complete !== true ||
    !validDigest(expected.definitionDigest) ||
    !validDigest(expected.evaluatorDigest) ||
    evidence.definitionDigest !== expected.definitionDigest ||
    evidence.evaluatorDigest !== expected.evaluatorDigest ||
    !validDigest(evidence.evidenceDigest)
  ) {
    return blocked(obligation, "The requested assay has no complete result from its sealed typed evaluator.");
  }
  return evidence.outcome === "pass"
    ? passed(obligation, "The sealed typed assay evaluator returned pass.")
    : failed(obligation, "The sealed typed assay evaluator returned fail.");
}

/**
 * Evaluates one critical obligation without consulting model prose or a generic
 * command success flag. PASSED and FAILED are decisive; BLOCKED is never so.
 */
export function evaluateForgeOracle(
  obligation: IntentObligation,
  plan: SealedForgeOraclePlan,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  if (obligation.assayability !== "ASSAYABLE" || obligation.oracle === undefined) {
    return blocked(obligation, "The sealed obligation has no mechanically assayable oracle.");
  }
  const executionProblem = validateExecution(obligation, plan, observation);
  if (executionProblem !== undefined) return executionProblem;

  const oracle = obligation.oracle;
  switch (oracle.kind) {
    case "command_exit_code":
      return evaluateCommandExitCode(obligation, oracle, plan, observation);
    case "exact_output":
      return evaluateExactOutput(obligation, oracle, observation);
    case "output_parse":
      return evaluateOutputParse(obligation, oracle, observation);
    case "path_exists":
      return evaluatePathExists(obligation, oracle, observation);
    case "network_access_count":
      return evaluateNetworkAccessCount(obligation, oracle, observation);
    case "sealed_subject_digest":
      return evaluateSealedSubjectDigest(obligation, oracle, plan, observation);
    case "sealed_test_suite":
      return evaluateSealedTestSuite(obligation, oracle, plan, observation);
    case "requested_assay":
      return evaluateRequestedAssay(obligation, oracle, plan, observation);
  }
}
