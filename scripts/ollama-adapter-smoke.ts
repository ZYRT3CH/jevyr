/**
 * Reviewable, local-only smoke for the OpenAI-compatible Mind boundary.
 *
 * This is intentionally not an end-to-end Jevyr Case and it never executes
 * model-authored source. It asks one loopback Ollama model for a finite
 * candidate, passes the returned JSON through the real blueprint compiler,
 * checks experiment readiness, prints only metadata, and removes its one
 * private temporary policy directory.
 */
import type { Stats } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { compileIntentContract } from "../packages/core/src/index.js";
import { createSearchEnvelope, digestJson, type JsonValue } from "../packages/protocol/src/index.js";
import {
  DEFAULT_SEARCH_PROFILE,
  OpenAICompatibleMindAdapter,
  candidateExperimentReadiness,
  compileCandidateBlueprint,
  loadJevyrIgnorePolicy,
  type ExperimentCapability,
  type MindRequest,
  type SealedCaseContext,
} from "../packages/runtime/src/index.js";

const MODEL = "qwen3-coder:30b-32k";
const BASE_URL = "http://127.0.0.1:11434/v1/";
const ENTRY_FILE = "jevyr.experiment.mjs";
const COMPLETION_TOKEN_LIMIT = 4_096;
const INVOCATION_TIMEOUT_MS = 300_000;
const IMPULSE = [
  "Build a bounded two-bin streaming scheduler.",
  "Accept a fixed numeric weight stream and assign each arriving item immediately",
  "to the currently lighter bin, with deterministic A-bin tie breaking.",
  "Include an executable self-check that verifies every item is assigned exactly once",
  `and reports the final imbalance from ${ENTRY_FILE}.`,
].join(" ");

function repeatedDigest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function within(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function capability(intentContractDigest: string): ExperimentCapability {
  const entryArgs: readonly [string] = Object.freeze([ENTRY_FILE]);
  const payload: Omit<ExperimentCapability, "digest"> = {
    protocol: "jevyr.experiment-capability/1",
    frontierDigest: repeatedDigest("6"),
    intentContractDigest,
    experiments: Object.freeze([Object.freeze({
      assayId: "jevyr.experiment.node-v1",
      costUnits: 1,
      timeoutMs: 10_000,
      tool: "forge.command",
      command: Object.freeze({ executable: "node", args: entryArgs, shell: false }),
      entryFile: ENTRY_FILE,
      authority: "comparative-only",
    })]),
  };
  return Object.freeze({ ...payload, digest: digestJson(payload as unknown as JsonValue) });
}

async function main(): Promise<void> {
  const started = performance.now();
  const contract = compileIntentContract({ impulse: IMPULSE });
  const experimentCapability = capability(contract.digest);
  const sealed: SealedCaseContext = {
    protocol: "jevyr.case/1",
    caseId: "case_local_adapter_smoke_12345678",
    submissionDigest: repeatedDigest("0"),
    subjectMaterialCaptureDigest: repeatedDigest("1"),
    caseDigest: repeatedDigest("2"),
    runDigest: repeatedDigest("3"),
    sealedAt: new Date().toISOString(),
    policyVersion: "jevyr.bone/1",
    policyDigest: repeatedDigest("4"),
    genomeVersion: "jevyr.genome/1",
    genomeDigest: repeatedDigest("5"),
    searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
    intentContractDigest: contract.digest,
    intentContract: contract,
    intent: {
      impulse: IMPULSE,
      mode: "auto",
      subjects: [],
      constraints: [],
      requestedAssays: [],
      privacy: "local_only",
      control: "sovereign",
      seed: "ollama-local-adapter-smoke",
    },
    subjects: [],
  };
  const adapter = new OpenAICompatibleMindAdapter({
    id: "mind.ollama.qwen3-coder-30b-32k.local-smoke",
    displayName: `Ollama ${MODEL}`,
    baseUrl: BASE_URL,
    model: MODEL,
    timeoutMs: INVOCATION_TIMEOUT_MS,
  });
  const probe = await adapter.probe(AbortSignal.timeout(5_000));
  if (!probe.available) throw new Error(`Ollama unavailable: ${probe.detail}`);

  const request: MindRequest = {
    stage: "diverge",
    role: "divergent",
    sealed,
    publicFacts: [],
    seed: repeatedDigest("8"),
    constraints: [],
    experimentCapability,
    maxOutputTokens: COMPLETION_TOKEN_LIMIT,
    signal: AbortSignal.timeout(INVOCATION_TIMEOUT_MS),
  };
  const result = await adapter.runMetered(request);
  const contribution = result.contributions[0];
  if (contribution?.candidateBlueprintSource === undefined) {
    throw new Error("The adapter returned no finite candidate source");
  }

  const temporaryParent = await realpath(resolve(tmpdir()));
  const policyRoot = await mkdtemp(join(temporaryParent, "jevyr-ollama-adapter-smoke-"));
  const createdIdentity = await lstat(policyRoot);
  const createdRealPath = await realpath(policyRoot);
  if (createdIdentity.isSymbolicLink()
    || !createdIdentity.isDirectory()
    || !within(temporaryParent, createdRealPath)
    || !createdRealPath.startsWith(join(temporaryParent, "jevyr-ollama-adapter-smoke-"))) {
    throw new Error("The private smoke directory was not created as a real child of the OS temp directory");
  }
  try {
    const policy = await loadJevyrIgnorePolicy(createdRealPath);
    const blueprint = compileCandidateBlueprint(contribution.candidateBlueprintSource, policy);
    const readiness = candidateExperimentReadiness(blueprint, experimentCapability);
    if (!readiness.ready) {
      throw new Error(`The compiled candidate is not experiment-ready: ${readiness.problems.join(", ")}`);
    }
    process.stdout.write(`${JSON.stringify({
      protocol: "jevyr.local-adapter-smoke/1",
      fixtureOnly: true,
      candidateExecuted: false,
      provider: { baseUrl: BASE_URL, model: MODEL, probe: probe.detail },
      limits: { completionTokens: COMPLETION_TOKEN_LIMIT, invocationMillis: INVOCATION_TIMEOUT_MS },
      latencyMs: Math.round(performance.now() - started),
      tokenUsage: result.tokenUsage,
      transmittedInputBytes: result.transmittedInputBytes,
      receivedOutputBytes: result.receivedOutputBytes,
      summary: contribution.summary,
      blueprintDigest: blueprint.blueprintDigest,
      files: blueprint.files.map((file) => ({
        path: file.path,
        bytes: file.byteLength,
        digest: file.digest,
      })),
      commandProposal: blueprint.command,
      experimentReadiness: readiness,
    }, null, 2)}\n`);
  } finally {
    const finalIdentity = await lstat(policyRoot);
    const finalRealPath = await realpath(policyRoot);
    if (finalIdentity.isSymbolicLink()
      || !finalIdentity.isDirectory()
      || !sameIdentity(createdIdentity, finalIdentity)
      || finalRealPath !== createdRealPath
      || !within(temporaryParent, finalRealPath)
      || !finalRealPath.startsWith(join(temporaryParent, "jevyr-ollama-adapter-smoke-"))) {
      throw new Error("Refusing to remove a smoke directory whose final identity or containment changed");
    }
    await rm(finalRealPath, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
