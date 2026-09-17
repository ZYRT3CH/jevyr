import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createJevyrHttpService } from "../apps/daemon/src/server.js";
import { initialize, DEFAULT_POLICY } from "../apps/cli/src/config.js";
import { loadCorpus, runCorpus, type BenchmarkResult } from "../apps/cli/src/benchmark.js";
import { createReleaseReport } from "../apps/cli/src/release-report.js";
import { exportLocalProof } from "../apps/cli/src/local-proof.js";
import { JevyrClient } from "../packages/sdk/src/index.js";
import { RuleMindAdapter, DEFAULT_SEARCH_PROFILE } from "../packages/runtime/src/index.js";

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const root = join(repositoryRoot, "artifacts", `corpus-rule-${Date.now()}-${randomUUID().slice(0, 8)}`);
await initialize(root);
const snapshotRoot = join(root, "repository-source");
await mkdir(snapshotRoot, { recursive: true });
const inventory = (await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repositoryRoot, windowsHide: true, maxBuffer: 16 * 1_048_576 })).stdout.split("\0").filter(Boolean);
const sources = [];
for (const name of [...new Set(inventory)].sort()) {
  if (name.startsWith(".git/") || name.startsWith(".lavish/") || name.startsWith("artifacts/") || name.split("/").some((part) => ["node_modules", ".venv", "__pycache__", "dist"].includes(part))) continue;
  const source = resolve(repositoryRoot, name);
  const local = relative(repositoryRoot, source);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("Source inventory escaped the repository");
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) continue;
  const bytes = await readFile(source);
  const target = join(snapshotRoot, local);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
  sources.push({ path: name, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length });
}
await writeFile(join(root, "repository-source-manifest.json"), JSON.stringify({ protocol: "jevyr.repository-source-snapshot/1", sourceRoot: repositoryRoot, sourcePolicy: "git ignored-aware current source inventory; generated caches and design transcripts excluded", files: sources }, null, 2));
await writeFile(join(root, ".jevyr", "policy.json"), JSON.stringify({ ...DEFAULT_POLICY, search: { ...DEFAULT_SEARCH_PROFILE, nursery: { ...DEFAULT_SEARCH_PROFILE.nursery, minimumAttempts: 2, saturationWindow: 2, independentLineages: 2 }, resources: { ...DEFAULT_SEARCH_PROFILE.resources, maxMindInvocations: 8, maxInputTokens: 2_000_000, maxGeneratedBytes: 2_000_000, concurrentLineages: 2 } } }));
const original = await loadCorpus(join(repositoryRoot, "benchmarks", "corpus.v1.json"));
const corpus = { ...original, cases: original.cases.map((entry) => entry.category === "repository_self" ? { ...entry, subjects: [{ id: "jevyr-repository", kind: "directory" as const, locator: snapshotRoot }] } : entry) };
await writeFile(join(root, "executed-corpus.json"), JSON.stringify(corpus, null, 2));
const service = createJevyrHttpService({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [new RuleMindAdapter()] });
try {
  const { url } = await service.listen(0);
  const client = new JevyrClient({ baseUrl: url });
  const results: BenchmarkResult[] = [];
  const pairs = new Map<string, string>();
  const proofs = [];
  // One request at a time keeps the baseline's amnesic/nursery and memory exposure explicit.
  for (const entry of corpus.cases) {
    process.stdout.write(`Running ${entry.id}\n`);
    let [result] = await runCorpus({ ...corpus, cases: [entry] }, client);
    if (!result) throw new Error("Corpus runner returned no result");
    if (entry.pair && result.record) {
      const earlier = pairs.get(entry.pair);
      if (earlier && earlier !== result.record.verdict.judgment) result = { ...result, passed: false, failures: [...result.failures, `wording pair ${entry.pair} changed judgment: ${earlier} -> ${result.record.verdict.judgment}`] };
      pairs.set(entry.pair, result.record.verdict.judgment);
    }
    results.push(result);
    if (result.caseId && result.record) {
      const verification = await exportLocalProof(client, result.caseId, join(root, "proofs", entry.id));
      proofs.push({ id: entry.id, verification });
      if (!verification.valid) throw new Error(`Signed corpus export ${entry.id} failed independent verification: ${verification.problems.join("; ")}`);
      await writeFile(join(root, "proofs.json"), JSON.stringify(proofs, null, 2));
    }
    process.stdout.write(`${result.passed ? "PASS" : "FAIL"} ${entry.id}: ${result.record?.verdict.judgment ?? "no Record"} ${result.failures.join("; ")}\n`);
    await writeFile(join(root, "results.json"), JSON.stringify(results, null, 2));
  }
  // Pair outcomes are descriptive; isolated evidence invariance requires its own experiment.
  const pairOutcomes = corpus.cases.filter((entry) => entry.pair).map((entry) => ({ pair: entry.pair, id: entry.id, judgment: results.find((result) => result.id === entry.id)?.record?.verdict.judgment ?? null }));
  const sourceChanges = [];
  for (const source of sources) {
    const after = `sha256:${createHash("sha256").update(await readFile(join(snapshotRoot, source.path))).digest("hex")}`;
    if (after !== source.digest) sourceChanges.push({ path: source.path, before: source.digest, after });
  }
  const report = { ...createReleaseReport(corpus, results), modelProduced: false, investigationMode: "explicit-built-in-rule-baseline", sourceSnapshotManifest: join(root, "repository-source-manifest.json"), sourceSnapshotUnchanged: sourceChanges.length === 0, sourceChanges, pairOutcomes, proofs };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`Rule corpus evidence: ${join(root, "report.json")}\n`);
  process.exitCode = results.every((result) => result.passed) ? 0 : 1;
} finally { await service.close(); }
