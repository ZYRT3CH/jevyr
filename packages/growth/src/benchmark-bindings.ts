import { canonicalize, digestJson, isSha256Digest, sha256Digest, type JsonValue, type SealedCase } from "@jevyr/protocol";
import type { PairedBenchmarkConfiguration, PairedGenomeTrial } from "./paired-benchmarks.js";

export interface PairedFixtureCorpus {
  readonly protocol: "jevyr.paired-genome-fixture/1";
  readonly impulse: string;
  readonly constraints: readonly string[];
  readonly cases: readonly { readonly caseKey: string; readonly clean: boolean; readonly files: readonly {readonly path: string; readonly content: string}[]; readonly criticalDefectIds: readonly string[] }[];
  readonly scope: string;
  readonly predicates: readonly {readonly id: string; readonly command: string; readonly expectedExitCode: number}[];
  readonly digest: string;
}
const json = (value: unknown) => value as JsonValue;
function exact(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key))) throw new TypeError(`${label} has unknown or missing fields`);
  return raw as Record<string, unknown>;
}
function ids(raw: unknown): asserts raw is string[] {
  if (!Array.isArray(raw) || raw.length > 1024 || new Set(raw).size !== raw.length || raw.some(id => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(id))) throw new TypeError("Fixture identifiers must be unique and finite");
}
export function validatePairedFixtureCorpus(raw: unknown): PairedFixtureCorpus {
  const value = exact(raw, ["protocol", "impulse", "constraints", "cases", "scope", "predicates", "digest"], "Paired fixture corpus");
  if (value.protocol !== "jevyr.paired-genome-fixture/1" || typeof value.impulse !== "string" || !value.impulse.trim() || value.impulse.length > 100_000
    || typeof value.scope !== "string" || !value.scope.trim() || value.scope.length > 10_000 || !isSha256Digest(value.digest)
    || !Array.isArray(value.constraints) || value.constraints.length > 1024 || value.constraints.some(item => typeof item !== "string" || item.length > 10_000)
    || !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 1024 || !Array.isArray(value.predicates) || !value.predicates.length || value.predicates.length > 1024) throw new TypeError("Invalid bounded fixture corpus");
  const predicateIds: string[] = [];
  for (const rawPredicate of value.predicates) {
    const predicate = exact(rawPredicate, ["id", "command", "expectedExitCode"], "Fixture predicate");
    ids([predicate.id]); predicateIds.push(predicate.id as string);
    if (typeof predicate.command !== "string" || !predicate.command.trim() || predicate.command.length > 4096 || !Number.isSafeInteger(predicate.expectedExitCode) || (predicate.expectedExitCode as number) < 0 || (predicate.expectedExitCode as number) > 255) throw new TypeError("Invalid finite fixture command predicate");
  }
  ids(predicateIds);
  const caseIds: string[] = [];
  for (const rawCase of value.cases) {
    const entry = exact(rawCase, ["caseKey", "clean", "files", "criticalDefectIds"], "Fixture case");
    ids([entry.caseKey]); caseIds.push(entry.caseKey as string); ids(entry.criticalDefectIds);
    if (typeof entry.clean !== "boolean" || entry.clean && entry.criticalDefectIds.length > 0 || entry.criticalDefectIds.some(id => !predicateIds.includes(id))
      || !Array.isArray(entry.files) || !entry.files.length || entry.files.length > 4096) throw new TypeError("Invalid fixture labels or files");
    const paths = new Set<string>();
    for (const rawFile of entry.files) {
      const file = exact(rawFile, ["path", "content"], "Fixture file");
      if (typeof file.path !== "string" || file.path.length > 512 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(file.path)
        || file.path.split("/").some(segment => segment === "." || segment === "..") || paths.has(file.path.toLowerCase()) || typeof file.content !== "string" || file.content.length > 1_048_576) throw new TypeError("Invalid fixture file path or bounded content");
      paths.add(file.path.toLowerCase());
    }
  }
  ids(caseIds);
  const { digest, ...body } = value;
  if (digest !== digestJson(json(body))) throw new TypeError("Fixture corpus digest mismatch");
  return structuredClone(value) as unknown as PairedFixtureCorpus;
}

/** Caller authenticates the full Seal and policy descriptor before this comparison. */
export function assertPairedTrialSealedBindings(trial: PairedGenomeTrial, configuration: PairedBenchmarkConfiguration, corpus: PairedFixtureCorpus, sealed: SealedCase, policy: Record<string, unknown>): void {
  const selection = policy.genomeSelection as {runtimeCompilation?:{runtimeProfile?:unknown}} | undefined;
  const preset = policy.presetSelection as {effectiveRuntimeProfile?:unknown} | undefined;
  const profile = preset?.effectiveRuntimeProfile ?? selection?.runtimeCompilation?.runtimeProfile;
  if (trial.seedDigest !== sha256Digest(sealed.intent.seed) || !Array.isArray(policy.mindCapabilities) || !policy.mindCapabilities.length
    || trial.providerSnapshotDigest !== digestJson(json(policy.mindCapabilities)) || canonicalize(json(configuration.runtimeProfile)) !== canonicalize(json(profile ?? null))
    || configuration.genomeDigest !== sealed.genomeDigest || trial.subjectDigest !== sealed.subjectMaterialCaptureDigest) throw new TypeError("Trial seed, provider snapshot, runtime profile, Genome or subject differs from its sealed execution");
  const fixture = corpus.cases.find(entry => entry.caseKey === trial.caseKey);
  if (!fixture || trial.corpusDigest !== corpus.digest || trial.clean !== fixture.clean || canonicalize(json(trial.criticalDefectIds)) !== canonicalize(json(fixture.criticalDefectIds))
    || sealed.intent.impulse !== corpus.impulse || canonicalize(json(sealed.intent.constraints)) !== canonicalize(json(corpus.constraints))) throw new TypeError("Trial corpus labels or intent differ from the predeclared fixture");
  const subject = sealed.intent.subjects[0];
  if (sealed.intent.subjects.length !== 1 || !subject || subject.id !== "fixture-source" || subject.kind !== "text" || subject.mediaType !== "application/json") throw new TypeError("Fixture trial requires its exact sealed source text subject");
  let files: unknown;
  try { files = JSON.parse(subject.locator); } catch { throw new TypeError("Sealed fixture source is not JSON"); }
  if (canonicalize(json(files)) !== canonicalize(json(fixture.files))) throw new TypeError("Sealed fixture source bytes differ from corpus files");
  for (const predicate of corpus.predicates) {
    if (!sealed.intentContract.criticalObligations.some(obligation => obligation.oracle?.kind === "command_exit_code" && obligation.oracle.operand === predicate.command && obligation.oracle.expected === String(predicate.expectedExitCode))) throw new TypeError("Fixture predicate is absent from the sealed critical obligations");
  }
}
