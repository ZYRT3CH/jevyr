import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sha256Digest } from "@jevyr/protocol";
import type { RepositorySubjectEvaluation } from "./repository-evaluation-plan.js";

export const REPOSITORY_TEST_CONTROLLER_LIMITS = Object.freeze({ timeoutMs: 30_000, maxEvents: 20_000, maxEventBytes: 2_000_000 });
export interface RepositoryTestControllerLimits { readonly timeoutMs: number; readonly maxEvents: number; readonly maxEventBytes: number }
export interface RepositoryTestControllerRequest {
  readonly protocol: "jevyr.repository-suite-controller-request/1";
  readonly target: "sealed-original-subject";
  readonly root: string;
  readonly suiteDigest: string;
  readonly testFiles: RepositorySubjectEvaluation["testFiles"];
  readonly sourceFiles: RepositorySubjectEvaluation["sourceFiles"];
  readonly configFiles: RepositorySubjectEvaluation["configFiles"];
  readonly limits: RepositoryTestControllerLimits;
}

/** Prepares an exact-inventory controller invocation, never runs repository code.
 * The standalone controller is intended for the separately enforced OCI boundary.
 * Its JSON and Node's child messages carry no independent evaluator authority. */
export function createRepositoryTestControllerRequest(subject: RepositorySubjectEvaluation, root: string, limits: Partial<RepositoryTestControllerLimits> = {}): RepositoryTestControllerRequest {
  if (subject.status !== "ready" || subject.refusals.length || !subject.runner || !subject.testFiles.length || subject.discoveredTestFiles !== subject.testFiles.length
    || !isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root) || root.length > 4096 || !/^sha256:[a-f0-9]{64}$/u.test(subject.suiteDigest)) throw new TypeError("A ready exact original-subject suite and absolute materialization root are required");
  if (Object.keys(limits).some(key => !Object.hasOwn(REPOSITORY_TEST_CONTROLLER_LIMITS, key))) throw new TypeError("Unknown controller limit");
  const bounded = { ...REPOSITORY_TEST_CONTROLLER_LIMITS, ...limits };
  for (const [key, minimum, maximum] of [["timeoutMs", 100, 60_000], ["maxEvents", 16, 100_000], ["maxEventBytes", 1024, 8_000_000]] as const)
    if (!Number.isSafeInteger(bounded[key]) || bounded[key] < minimum || bounded[key] > maximum) throw new TypeError(`Invalid controller ${key}`);
  return structuredClone({ protocol: "jevyr.repository-suite-controller-request/1", target: "sealed-original-subject", root, suiteDigest: subject.suiteDigest,
    testFiles: subject.testFiles, sourceFiles: subject.sourceFiles, configFiles: subject.configFiles, limits: bounded });
}

/** No arbitrary executable, package script, loader, argument or reporter hook. */
export async function repositoryTestControllerSource(): Promise<{ readonly bytes: Buffer; readonly digest: string }> {
  const bytes = await readFile(new URL("./repository-test-controller-runner.mjs", import.meta.url));
  if (bytes.length > 128_000) throw new TypeError("Controller implementation exceeds its retained source ceiling");
  return Object.freeze({ bytes, digest: sha256Digest(bytes) });
}

/** Recompute report fields from captured controller events; no execution. */
export async function summarizeRepositoryTestEvents(events: readonly unknown[], request: RepositoryTestControllerRequest, stream: unknown, inventory: unknown): Promise<{ report: { protocol: "jevyr.repository-suite-controller-report/1"; suiteDigest: string; complete: boolean; executedTests: number; passed: number; failed: number; errors: number; skipped: number; cancelled: number; fileOnlyPasses: number }; problems: readonly string[] }> {
  const module = await import(new URL("./repository-test-controller-runner.mjs", import.meta.url).href);
  return module.summarizeRepositoryTestEvents(events, request, stream, inventory);
}
