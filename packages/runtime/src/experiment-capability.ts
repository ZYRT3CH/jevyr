import { assertIntentContract } from "@jevyr/core";
import {
  digestJson,
  type IntentContract,
  type IntentObligation,
  type JsonValue,
  type SearchResourceEnvelope,
} from "@jevyr/protocol";
import { stableId } from "./canonical.js";
import { verifyAssayFrontier, type AssayFrontier, type SealedAssayPlan } from "./assay-frontier.js";
import type { CompiledCandidateBlueprint } from "./candidate-blueprints.js";
import type { ForgeOracleEvaluation, ForgeOracleObservation } from "./typed-oracles.js";
import { parseStrictOracleCommand } from "./typed-oracles.js";

export const EXPERIMENT_CAPABILITY_PROTOCOL = "jevyr.experiment-capability/1" as const;

export interface ExperimentCommand {
  readonly executable: "node" | "python3";
  readonly args: readonly [string];
  readonly shell: false;
}

export interface SealedCandidateExperiment {
  readonly assayId: string;
  readonly costUnits: number;
  readonly timeoutMs?: number;
  readonly tool: "forge.command";
  readonly command: ExperimentCommand;
  readonly entryFile: string;
  /**
   * Comparative experiments may shape the measured archive, but can never
   * support or refute an Intent Contract obligation.
   */
  readonly authority: "comparative-only" | "intent-bound";
  readonly obligationId?: string;
}

export interface ExperimentCapability {
  readonly protocol: typeof EXPERIMENT_CAPABILITY_PROTOCOL;
  readonly frontierDigest: string;
  readonly intentContractDigest: string;
  readonly experiments: readonly SealedCandidateExperiment[];
  readonly digest: string;
}

export interface CandidateExperimentReadiness {
  readonly ready: boolean;
  readonly experimentIds: readonly string[];
  readonly problems: readonly (
    | "no-sealed-experiment"
    | "missing-command-proposal"
    | "command-not-sealed"
    | "entry-file-missing"
  )[];
}

const ENTRY_FILE = /^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_+@.-]+(?:\/[A-Za-z0-9_+@.-]+)*$/u;

function planArgv(plan: SealedAssayPlan): readonly string[] | undefined {
  const command = plan.args.command;
  const args = plan.args.args;
  if (typeof command !== "string" || !Array.isArray(args) || args.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return Object.freeze([command, ...(args as readonly string[])]);
}

function exactArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function intentObligationFor(
  contract: IntentContract,
  plan: SealedAssayPlan,
  argv: readonly string[],
): IntentObligation | undefined {
  if (plan.obligationId !== undefined) {
    const explicit = contract.criticalObligations.find((entry) => entry.id === plan.obligationId);
    if (explicit?.assayability !== "ASSAYABLE" || explicit.oracle?.kind !== "command_exit_code") return undefined;
    const expected = parseStrictOracleCommand(explicit.oracle.operand);
    return expected !== undefined && exactArgv(expected, argv) ? explicit : undefined;
  }
  const matches = contract.criticalObligations.filter((entry) => {
    if (entry.assayability !== "ASSAYABLE" || entry.oracle?.kind !== "command_exit_code") return false;
    const expected = parseStrictOracleCommand(entry.oracle.operand);
    return expected !== undefined && exactArgv(expected, argv);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function entryCommand(plan: SealedAssayPlan): ExperimentCommand | undefined {
  if (plan.sealedSubjectDigest !== undefined || plan.sealedTestSuite !== undefined || plan.requestedAssay !== undefined) {
    return undefined;
  }
  const argv = planArgv(plan);
  if (argv?.length !== 2) return undefined;
  const [executable, entryFile] = argv;
  if ((executable !== "node" && executable !== "python3") || entryFile === undefined) return undefined;
  if (
    entryFile.length === 0
    || entryFile.length > 4_096
    || entryFile.normalize("NFC") !== entryFile
    || entryFile.includes("\\")
    || entryFile.startsWith("/")
    || /^[A-Za-z]:/u.test(entryFile)
    || !ENTRY_FILE.test(entryFile)
    || entryFile === ".jevyr-subjects"
    || entryFile.startsWith(".jevyr-subjects/")
  ) {
    return undefined;
  }
  if (executable === "node" && !/\.(?:mjs|js)$/u.test(entryFile)) return undefined;
  if (executable === "python3" && !/\.py$/u.test(entryFile)) return undefined;
  return Object.freeze({ executable, args: Object.freeze([entryFile] as [string]), shell: false });
}

/**
 * Reduces the operator-sealed Assay Frontier to the only model-visible
 * experiment grammar. No candidate value is consulted and no new authority is
 * created here: the descriptor is a deterministic view of values sealed at
 * Cast plus the exact Intent Contract.
 */
export function compileExperimentCapability(
  frontier: AssayFrontier | undefined,
  contract: IntentContract,
): ExperimentCapability {
  assertIntentContract(contract);
  const verifiedFrontier = frontier === undefined
    ? undefined
    : verifyAssayFrontier(frontier, frontier.aggregateLimits as unknown as SearchResourceEnvelope);
  const experiments: SealedCandidateExperiment[] = [];
  for (const plan of verifiedFrontier?.assays ?? []) {
    const command = entryCommand(plan);
    if (command === undefined) continue;
    const argv = Object.freeze([command.executable, ...command.args]);
    const obligation = intentObligationFor(contract, plan, argv);
    // An explicit but invalid obligation binding must fail closed; it cannot be
    // silently downgraded into a comparative experiment.
    if (plan.obligationId !== undefined && obligation === undefined) continue;
    experiments.push(Object.freeze({
      assayId: plan.assayId,
      costUnits: plan.costUnits,
      ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
      tool: "forge.command",
      command,
      entryFile: command.args[0],
      authority: obligation === undefined ? "comparative-only" : "intent-bound",
      ...(obligation === undefined ? {} : { obligationId: obligation.id }),
    }));
  }
  experiments.sort((left, right) => left.assayId < right.assayId ? -1 : left.assayId > right.assayId ? 1 : 0);
  const payload = Object.freeze({
    protocol: EXPERIMENT_CAPABILITY_PROTOCOL,
    frontierDigest: verifiedFrontier?.digest ?? digestJson({ protocol: "jevyr.no-assay-frontier/1" }),
    intentContractDigest: contract.digest,
    experiments: Object.freeze(experiments),
  });
  return Object.freeze({ ...payload, digest: digestJson(payload as unknown as JsonValue) });
}

export function experimentForPlan(
  capability: ExperimentCapability | undefined,
  plan: SealedAssayPlan,
): SealedCandidateExperiment | undefined {
  return capability?.experiments.find((entry) => entry.assayId === plan.assayId);
}

export function candidateExperimentReadiness(
  blueprint: CompiledCandidateBlueprint,
  capability: ExperimentCapability,
): CandidateExperimentReadiness {
  const notReady = (problem: CandidateExperimentReadiness["problems"][number]): CandidateExperimentReadiness =>
    Object.freeze({
      ready: false,
      experimentIds: Object.freeze([]),
      problems: Object.freeze([problem]),
    });
  if (capability.experiments.length === 0) {
    return notReady("no-sealed-experiment");
  }
  if (blueprint.command === undefined) {
    return notReady("missing-command-proposal");
  }
  const proposed = Object.freeze([blueprint.command.executable, ...blueprint.command.args]);
  const commandMatches = capability.experiments.filter((entry) =>
    exactArgv(proposed, [entry.command.executable, ...entry.command.args]));
  if (commandMatches.length === 0) {
    return notReady("command-not-sealed");
  }
  const files = new Set(blueprint.files.map((file) => file.path));
  const ready = commandMatches.filter((entry) => files.has(entry.entryFile));
  if (ready.length === 0) {
    return notReady("entry-file-missing");
  }
  return Object.freeze({
    ready: true,
    experimentIds: Object.freeze(ready.map((entry) => entry.assayId).sort()),
    problems: Object.freeze([]),
  });
}

/** Replays the narrow comparative exit oracle without minting an Intent edge. */
export function evaluateComparativeExperiment(
  experiment: SealedCandidateExperiment,
  observation: ForgeOracleObservation,
): ForgeOracleEvaluation {
  const evaluationId = stableId("experiment", {
    assayId: experiment.assayId,
    command: experiment.command,
  });
  const execution = observation.execution;
  const expectedArgs = experiment.command.args;
  const blocked = (reason: string): ForgeOracleEvaluation => Object.freeze({
    obligationId: evaluationId,
    status: "BLOCKED",
    decisive: false,
    reason,
  });
  if (experiment.authority !== "comparative-only") {
    return blocked("Intent-bound experiments must use the sealed Intent oracle.");
  }
  if (execution.state !== "exited") return blocked("The comparative experiment did not produce a completed process exit.");
  if (execution.shell !== false) return blocked("The comparative experiment used or may have used a shell.");
  if (execution.command !== experiment.command.executable || !exactArgv(execution.args ?? [], expectedArgs)) {
    return blocked("The comparative experiment executed argv different from its sealed experiment socket.");
  }
  if (!Number.isSafeInteger(execution.exitCode)) return blocked("The comparative experiment has no bounded integer exit code.");
  return Object.freeze({
    obligationId: evaluationId,
    status: execution.exitCode === 0 ? "PASSED" : "FAILED",
    decisive: true,
    reason: execution.exitCode === 0
      ? "The sealed comparative experiment exited with code 0; this ranks candidates but does not satisfy an Intent obligation."
      : `The sealed comparative experiment exited with code ${execution.exitCode}; this ranks candidates but does not refute an Intent obligation.`,
  });
}

export function blockedComparativeExperiment(
  experiment: SealedCandidateExperiment,
  reason: string,
): ForgeOracleEvaluation {
  return Object.freeze({
    obligationId: stableId("experiment", { assayId: experiment.assayId, command: experiment.command }),
    status: "BLOCKED",
    decisive: false,
    reason,
  });
}
