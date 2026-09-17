import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseJsonBytes } from "@jevyr/core";
import { JevyrClient, type JevyrAxes, type JevyrRecord } from "@jevyr/sdk";
import { replayAuthenticatedCase, type ReplayResult } from "./replay.js";

const MAX_BENCHMARK_CORPUS_BYTES = 16 * 1_048_576;
const MAX_BENCHMARK_CASES = 10_000;

export interface BenchmarkCase {
  readonly id: string;
  readonly category: string;
  readonly impulse: string;
  readonly mode?: "auto" | "audit" | "design";
  readonly constraints?: readonly string[];
  readonly requestedAssays?: readonly string[];
  readonly seed?: string;
  readonly subjects?: readonly { id: string; kind: "git" | "directory" | "file" | "url" | "text" | "artifact"; locator: string; revision?: string; mediaType?: string }[];
  readonly privacy?: "full_case" | "provider_scoped" | "local_only";
  readonly pair?: string;
  readonly expect: {
    readonly integrity?: JevyrAxes["integrity"];
    readonly creation?: JevyrAxes["creation"] | "PRESENT";
    readonly embodiment?: JevyrAxes["embodiment"];
    readonly judgment?: JevyrAxes["judgment"] | "PRESENT";
  };
}

export interface BenchmarkCorpus {
  readonly protocol: "jevyr.benchmark-corpus/1";
  readonly description?: string;
  readonly cases: readonly BenchmarkCase[];
  readonly requiredInvariants: readonly string[];
}

export interface BenchmarkResult {
  readonly id: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly record?: JevyrRecord;
  readonly caseId?: string;
  readonly replay?: ReplayResult;
}

export async function loadCorpus(path: string): Promise<BenchmarkCorpus> {
  const bytes = await readFile(resolve(path));
  if (bytes.byteLength > MAX_BENCHMARK_CORPUS_BYTES) {
    throw new RangeError(`Benchmark corpus exceeds ${MAX_BENCHMARK_CORPUS_BYTES} bytes`);
  }
  const corpus: unknown = parseJsonBytes(bytes, "Benchmark corpus");
  validateCorpus(corpus);
  return corpus;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], path: string): void {
  const names = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !names.has(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown fields: ${unknown.sort().join(", ")}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
}

function boundedString(value: unknown, path: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${path} must be a non-empty string of at most ${maximum} characters`);
  }
}

function oneOf(value: unknown, choices: readonly string[], path: string): void {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new TypeError(`${path} must be one of ${choices.join(", ")}`);
  }
}

export function validateCorpus(corpusValue: unknown): asserts corpusValue is BenchmarkCorpus {
  const corpus = record(corpusValue, "Benchmark corpus");
  exactKeys(corpus, ["protocol", "description", "cases", "requiredInvariants"], ["protocol", "cases", "requiredInvariants"], "Benchmark corpus");
  if (corpus.protocol !== "jevyr.benchmark-corpus/1") throw new TypeError("Unsupported benchmark corpus protocol");
  if (corpus.description !== undefined) boundedString(corpus.description, "Benchmark corpus.description", 4_096);
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0 || corpus.cases.length > MAX_BENCHMARK_CASES) {
    throw new TypeError(`Benchmark corpus must contain 1-${MAX_BENCHMARK_CASES} cases`);
  }
  if (!Array.isArray(corpus.requiredInvariants) || corpus.requiredInvariants.length > 1_000) {
    throw new TypeError("Benchmark requiredInvariants must be an array of at most 1000 entries");
  }
  const invariants = new Set<string>();
  for (let index = 0; index < corpus.requiredInvariants.length; index += 1) {
    const invariant = corpus.requiredInvariants[index];
    boundedString(invariant, `Benchmark requiredInvariants[${index}]`, 1_024);
    if (invariants.has(invariant)) throw new TypeError(`Duplicate benchmark invariant: ${invariant}`);
    invariants.add(invariant);
  }
  const ids = new Set<string>();
  for (let index = 0; index < corpus.cases.length; index += 1) {
    const entry = record(corpus.cases[index], `Benchmark cases[${index}]`);
    exactKeys(
      entry,
      ["id", "category", "impulse", "mode", "constraints", "requestedAssays", "seed", "subjects", "privacy", "pair", "expect"],
      ["id", "category", "impulse", "expect"],
      `Benchmark cases[${index}]`,
    );
    boundedString(entry.id, `Benchmark cases[${index}].id`, 128);
    boundedString(entry.category, `Benchmark cases[${index}].category`, 256);
    boundedString(entry.impulse, `Benchmark cases[${index}].impulse`, 100_000);
    if (ids.has(entry.id)) throw new TypeError(`Duplicate benchmark id: ${entry.id}`);
    ids.add(entry.id);
    if (entry.mode !== undefined) oneOf(entry.mode, ["auto", "audit", "design"], `Benchmark ${entry.id}.mode`);
    if (entry.seed !== undefined) boundedString(entry.seed, `Benchmark ${entry.id}.seed`, 1_024);
    for (const field of ["constraints", "requestedAssays"] as const) {
      if (entry[field] !== undefined) {
        if (!Array.isArray(entry[field]) || entry[field].length > 128) throw new TypeError(`Benchmark ${entry.id}.${field} must be an array of at most 128 strings`);
        for (const value of entry[field]) boundedString(value, `Benchmark ${entry.id}.${field}`, 100_000);
      }
    }
    if (entry.privacy !== undefined) oneOf(entry.privacy, ["full_case", "provider_scoped", "local_only"], `Benchmark ${entry.id}.privacy`);
    if (entry.pair !== undefined) boundedString(entry.pair, `Benchmark ${entry.id}.pair`, 128);
    if (entry.subjects !== undefined) {
      if (!Array.isArray(entry.subjects) || entry.subjects.length > 32) {
        throw new TypeError(`Benchmark ${entry.id}.subjects must contain at most 32 entries`);
      }
      const subjectIds = new Set<string>();
      for (let subjectIndex = 0; subjectIndex < entry.subjects.length; subjectIndex += 1) {
        const subject = record(entry.subjects[subjectIndex], `Benchmark ${entry.id}.subjects[${subjectIndex}]`);
        exactKeys(subject, ["id", "kind", "locator", "revision", "mediaType"], ["id", "kind", "locator"], `Benchmark ${entry.id}.subjects[${subjectIndex}]`);
        boundedString(subject.id, `Benchmark ${entry.id}.subjects[${subjectIndex}].id`, 128);
        if (subjectIds.has(subject.id)) throw new TypeError(`Benchmark ${entry.id} has duplicate subject id ${subject.id}`);
        subjectIds.add(subject.id);
        oneOf(subject.kind, ["git", "directory", "file", "url", "text", "artifact"], `Benchmark ${entry.id}.subjects[${subjectIndex}].kind`);
        boundedString(subject.locator, `Benchmark ${entry.id}.subjects[${subjectIndex}].locator`, 1_000_000);
        if (subject.revision !== undefined) boundedString(subject.revision, `Benchmark ${entry.id}.subjects[${subjectIndex}].revision`, 4_096);
        if (subject.mediaType !== undefined) boundedString(subject.mediaType, `Benchmark ${entry.id}.subjects[${subjectIndex}].mediaType`, 256);
      }
    }
    const expect = record(entry.expect, `Benchmark ${entry.id}.expect`);
    exactKeys(expect, ["integrity", "creation", "embodiment", "judgment"], ["creation", "judgment"], `Benchmark ${entry.id}.expect`);
    if (expect.integrity !== undefined) oneOf(expect.integrity, ["VALID", "INVALID"], `Benchmark ${entry.id}.expect.integrity`);
    oneOf(expect.creation, ["CONCEIVED", "NO_SURVIVOR", "FAILED", "PRESENT"], `Benchmark ${entry.id}.expect.creation`);
    if (expect.embodiment !== undefined) oneOf(expect.embodiment, ["BUILT", "NOT_BUILT", "FAILED"], `Benchmark ${entry.id}.expect.embodiment`);
    oneOf(expect.judgment, ["ACCEPT", "REJECT", "UNPROVEN", "NOT_APPLICABLE", "PRESENT"], `Benchmark ${entry.id}.expect.judgment`);
    if (!expect.creation || !expect.judgment) {
      throw new TypeError(`Benchmark ${entry.id} must assert both creation and judgment`);
    }
  }
}

function evaluate(entry: BenchmarkCase, record: JevyrRecord): string[] {
  const failures: string[] = [];
  for (const axis of ["integrity", "creation", "embodiment", "judgment"] as const) {
    const expected = entry.expect[axis];
    if (expected !== undefined && expected !== "PRESENT" && record.verdict[axis] !== expected) {
      failures.push(`${axis}: expected ${expected}, received ${record.verdict[axis]}`);
    }
    if (expected === "PRESENT" && !record.verdict[axis]) failures.push(`${axis}: missing`);
  }
  return failures;
}

export async function runCorpus(corpus: BenchmarkCorpus, client: JevyrClient): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const pairJudgments = new Map<string, JevyrAxes["judgment"]>();
  for (const entry of corpus.cases) {
    try {
      const accepted = await client.cast({
        protocol: "jevyr.case/1",
        case: {
          impulse: entry.impulse,
          seed: entry.seed ?? `benchmark:${entry.pair ?? entry.id}:v1`,
          ...(entry.mode ? { mode: entry.mode } : {}),
          ...(entry.constraints ? { constraints: entry.constraints } : {}),
          ...(entry.requestedAssays ? { requestedAssays: entry.requestedAssays } : {}),
          ...(entry.subjects ? { subjects: entry.subjects } : {}),
          privacy: entry.privacy ?? "local_only",
          control: "sovereign",
        },
      });
      const record = (await client.waitForAuthenticatedRecord(accepted.caseId)).payload;
      const failures = evaluate(entry, record);
      const replay = await replayAuthenticatedCase(client, accepted.caseId, record);
      for (const problem of replay.problems) failures.push(`independent replay: ${problem}`);
      if (!replay.valid && replay.problems.length === 0) {
        failures.push("independent replay did not establish persisted-evidence validity");
      }
      if (entry.pair) {
        const previous = pairJudgments.get(entry.pair);
        if (previous && previous !== record.verdict.judgment) failures.push(`wording pair ${entry.pair} changed judgment: ${previous} -> ${record.verdict.judgment}`);
        pairJudgments.set(entry.pair, record.verdict.judgment);
      }
      results.push({ id: entry.id, passed: failures.length === 0, failures, record, caseId: accepted.caseId, replay });
    } catch (error) {
      results.push({ id: entry.id, passed: false, failures: [error instanceof Error ? error.message : String(error)] });
    }
  }
  return results;
}
