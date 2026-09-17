import { createRequire } from "node:module";
import { posix } from "node:path";
import { Parser, Language, type Node as SyntaxNode } from "web-tree-sitter";
import { assertIntentContract, parseJsonText } from "@jevyr/core";
import { canonicalize, digestJson, isSha256Digest, sha256Digest, type IntentContract, type JsonValue } from "@jevyr/protocol";
import type { SubjectContextReader } from "./subject-context.js";
import type { SubjectMaterialBinding, SubjectMaterialEntry, SubjectMaterialManifest } from "./subject-materials.js";

export const REPOSITORY_EVALUATION_PLAN_PROTOCOL = "jevyr.repository-evaluation-plan/1" as const;
export const REPOSITORY_EVALUATION_DISCOVERY = "jevyr.dependency-free-node-tests/1" as const;
export const REPOSITORY_EVALUATION_LIMITS = Object.freeze({ maxSubjects: 16, maxManifestBytes: 16 * 1024 * 1024, maxTestFiles: 64, maxSourceFiles: 256, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxSyntaxNodes: 100_000 });
export type RepositoryEvaluationLimits = typeof REPOSITORY_EVALUATION_LIMITS;
/** This descriptor must come from the startup capability registry, never model
 * output, package scripts, repository configuration, or a peer response. */
export interface RepositoryEvaluatorRunner {
  readonly id: "node-test-v1";
  readonly evaluatorDigest: string;
  readonly immutableImageId: string;
  readonly capabilityId: string;
}
export interface RepositoryEvaluationFile { readonly path: string; readonly digest: string; readonly bytes: number }
export interface RepositoryEvaluationRefusal { readonly code: string; readonly path?: string }
export interface RepositorySubjectEvaluation {
  readonly subjectId: string;
  readonly manifestDigest: string;
  readonly status: "ready" | "unavailable";
  readonly suiteDigest: string;
  readonly testFiles: readonly RepositoryEvaluationFile[];
  readonly sourceFiles: readonly RepositoryEvaluationFile[];
  readonly configFiles: readonly RepositoryEvaluationFile[];
  readonly discoveredTestFiles: number;
  readonly authority: "intent-bound" | "comparative-only";
  readonly obligationIds: readonly string[];
  readonly runner?: RepositoryEvaluatorRunner;
  readonly refusals: readonly RepositoryEvaluationRefusal[];
}
export interface RepositoryEvaluationPlan {
  readonly protocol: typeof REPOSITORY_EVALUATION_PLAN_PROTOCOL;
  readonly discovery: typeof REPOSITORY_EVALUATION_DISCOVERY;
  readonly captureDigest: string;
  readonly intentContractDigest: string;
  readonly scope: "exact-existing-test-suite";
  readonly target: "sealed-original-subject";
  readonly status: "ready" | "partial" | "unavailable";
  readonly subjects: readonly RepositorySubjectEvaluation[];
  readonly coverage: Readonly<{ subjects: number; discoveredTestFiles: number; plannedTestFiles: number; omittedTestFiles: number }>;
  readonly limits: RepositoryEvaluationLimits;
  readonly digest: string;
}
export interface RepositoryEvaluationInput {
  readonly captureDigest: string;
  readonly bindings: readonly SubjectMaterialBinding[];
  readonly reader: SubjectContextReader;
  readonly contract: IntentContract;
  readonly runner?: RepositoryEvaluatorRunner;
  readonly limits?: Partial<RepositoryEvaluationLimits>;
}
const json = (value: unknown) => value as JsonValue;
const hash = (value: unknown) => digestJson(json(value));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const safeError = () => new TypeError("Repository evaluator planning refused malformed or mismatched sealed input");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const safePath = (path: unknown): path is string => typeof path === "string" && path.length > 0 && Buffer.byteLength(path) <= 4096
  && !/[:\\\u0000-\u001f\u007f]/u.test(path) && !path.startsWith("/") && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
const isTest = (path: string) => /(?:^|\/)(?:test-[^/]+|[^/]+\.(?:test|spec))\.(?:[cm]?js|[cm]?ts|tsx|jsx|py)$/u.test(path)
  || /(?:^|\/)(?:test|tests)\/.*\.(?:[cm]?js|[cm]?ts|tsx|jsx|py)$/u.test(path);
const metadata = (entry: SubjectMaterialEntry): RepositoryEvaluationFile => Object.freeze({ path: entry.path, digest: entry.blobDigest, bytes: entry.byteLength });
const BUILTINS = new Set(["test", "assert", "assert/strict", "buffer", "crypto", "events", "path", "path/posix", "path/win32", "url", "util", "util/types", "string_decoder", "stream", "stream/promises", "timers", "timers/promises", "perf_hooks"]);
const unsupportedConfig = (path: string) => /(?:^|\/)(?:node_modules|\.pnp\.[^/]+|\.mocharc[^/]*|(?:jest|vitest|babel|webpack|rollup)\.config\.[^/]+|tsconfig(?:\.[^/]+)?\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/u.test(path);
const require = createRequire(import.meta.url);
let grammar: Promise<Language> | undefined;
const language = () => grammar ??= (async () => { await Parser.init(); return await Language.load(require.resolve("tree-sitter-wasms/out/tree-sitter-javascript.wasm")); })();

function literal(node: SyntaxNode | null): string | undefined {
  if (node?.type !== "string" || /\\/u.test(node.text)) return undefined;
  return node.text.slice(1, -1);
}
interface SyntaxInspection { readonly imports: readonly string[]; readonly hasNodeTests: boolean; readonly moduleSyntax: boolean; readonly refusal?: string }
async function inspectSource(text: string, maxNodes: number): Promise<SyntaxInspection> {
  const selectedGrammar = await language(), parser = new Parser(); let tree: ReturnType<Parser["parse"]> = null;
  try {
    parser.setLanguage(selectedGrammar); tree = parser.parse(text);
    if (!tree || tree.rootNode.hasError) return { imports: [], hasNodeTests: false, moduleSyntax: false, refusal: "SOURCE_PARSE_ERROR" };
    const imports = new Set<string>(); let nodes = 0, moduleSyntax = false;
    const stack = [tree.rootNode];
    while (stack.length) {
      if (++nodes > maxNodes) return { imports: [], hasNodeTests: false, moduleSyntax, refusal: "SYNTAX_BUDGET" };
      const node = stack.pop()!;
      if (node.type === "import_statement" || node.type === "export_statement") {
        moduleSyntax = true; const source = node.childForFieldName("source");
        if (source) { const value = literal(source); if (value === undefined) return { imports: [], hasNodeTests: false, moduleSyntax, refusal: "UNRESOLVED_IMPORT" }; imports.add(value); }
      }
      if (node.type === "call_expression" || node.type === "new_expression") {
        const fn = node.childForFieldName("function") ?? node.childForFieldName("constructor"), args = node.childForFieldName("arguments")?.namedChildren ?? [];
        if (fn?.text === "require" || fn?.type === "import") {
          const value = args.length === 1 ? literal(args[0] ?? null) : undefined;
          if (value === undefined) return { imports: [], hasNodeTests: false, moduleSyntax, refusal: "DYNAMIC_IMPORT_OR_REQUIRE" }; imports.add(value);
        }
        if (["eval", "Function"].includes(fn?.text ?? "")) return { imports: [], hasNodeTests: false, moduleSyntax, refusal: "DYNAMIC_CODE" };
      }
      if (node.type === "identifier" && node.text === "require" && !(node.parent?.type === "call_expression" && node.parent.childForFieldName("function")?.id === node.id))
        return { imports: [], hasNodeTests: false, moduleSyntax, refusal: "INDIRECT_REQUIRE" };
      for (const child of node.namedChildren) if (child) stack.push(child);
    }
    return { imports: [...imports].sort(compare), hasNodeTests: imports.has("node:test"), moduleSyntax };
  } finally { tree?.delete(); parser.delete(); }
}

function validateRunner(runner: RepositoryEvaluatorRunner | undefined): RepositoryEvaluatorRunner | undefined {
  if (runner === undefined) return undefined;
  if (!object(runner) || Object.keys(runner).sort().join() !== ["id", "evaluatorDigest", "immutableImageId", "capabilityId"].sort().join()
    || runner.id !== "node-test-v1" || !isSha256Digest(runner.evaluatorDigest) || !isSha256Digest(runner.immutableImageId)
    || typeof runner.capabilityId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/u.test(runner.capabilityId)) throw safeError();
  return Object.freeze({ ...runner });
}
function verifiedManifest(manifest: SubjectMaterialManifest, binding: SubjectMaterialBinding, maxBytes: number): SubjectMaterialManifest {
  const encoded = canonicalize(json(manifest));
  if (Buffer.byteLength(encoded) > maxBytes || sha256Digest(encoded) !== binding.manifestDigest || manifest.protocol !== "jevyr.subject-material/1"
    || manifest.subjectId !== binding.subjectId || manifest.subjectKind !== binding.subjectKind || manifest.subjectDigest !== binding.subjectDigest
    || manifest.availability !== binding.availability || manifest.byteLength !== binding.byteLength || !Array.isArray(manifest.entries) || !Array.isArray(manifest.omissions)) throw safeError();
  let previous = "", bytes = 0;
  for (const entry of manifest.entries) {
    if (!safePath(entry.path) || compare(previous, entry.path) >= 0 || !isSha256Digest(entry.blobDigest) || !integer(entry.byteLength, 0, Number.MAX_SAFE_INTEGER)) throw safeError();
    previous = entry.path; bytes += entry.byteLength;
  }
  if (!Number.isSafeInteger(bytes) || bytes !== binding.byteLength || (binding.availability === "DECLARATION_ONLY" && bytes !== 0)) throw safeError();
  for (const omission of manifest.omissions) if ((omission.path !== undefined && !safePath(omission.path)) || typeof omission.reason !== "string") throw safeError();
  return JSON.parse(encoded) as SubjectMaterialManifest;
}

/** Capture must already be verified and frozen, but not yet signed as a Case.
 * Discovery never runs repository instructions or imports subject modules. The
 * result is an executable-plan proposal, not execution or verdict evidence. */
export async function planRepositoryEvaluation(input: RepositoryEvaluationInput): Promise<RepositoryEvaluationPlan> {
  try {
    assertIntentContract(input.contract);
    const contract = JSON.parse(canonicalize(json(input.contract))) as IntentContract;
    const limits = Object.freeze(Object.fromEntries(Object.entries(REPOSITORY_EVALUATION_LIMITS).map(([key, max]) => {
      const value = input.limits && Object.hasOwn(input.limits, key) ? input.limits[key as keyof RepositoryEvaluationLimits] : max;
      if (!integer(value, 1, max)) throw safeError(); return [key, value];
    }))) as RepositoryEvaluationLimits;
    if (input.limits && Object.keys(input.limits).some(key => !Object.hasOwn(REPOSITORY_EVALUATION_LIMITS, key))) throw safeError();
    if (!isSha256Digest(input.captureDigest) || !Array.isArray(input.bindings) || input.bindings.length > limits.maxSubjects
      || hash({ protocol: "jevyr.subject-material-capture/1", bindings: input.bindings }) !== input.captureDigest) throw safeError();
    const bindings = JSON.parse(canonicalize(json(input.bindings))) as SubjectMaterialBinding[];
    if (new Set(bindings.map(binding => binding.subjectId)).size !== bindings.length || bindings.some(binding => typeof binding.subjectId !== "string" || !binding.subjectId.trim()
      || !isSha256Digest(binding.manifestDigest) || !isSha256Digest(binding.subjectDigest) || !integer(binding.byteLength, 0, Number.MAX_SAFE_INTEGER))) throw safeError();
    if ([...bindings].sort((a, b) => compare(a.subjectId, b.subjectId)).map(binding => binding.subjectId).join("\0") !== [...contract.subjectIds].sort(compare).join("\0")) throw safeError();
    bindings.forEach(binding => Object.freeze(binding));
    const runner = validateRunner(input.runner), subjects: RepositorySubjectEvaluation[] = [];
    const obligations = contract.criticalObligations.filter(obligation => obligation.assayability === "ASSAYABLE" && obligation.oracle?.kind === "sealed_test_suite"
      && obligation.oracle.operand === "sealed_subject_test_suite" && obligation.oracle.operator === "passes" && obligation.oracle.expected === "zero_failures");
    let bytesRead = 0, sourceFileCount = 0, plannedTestCount = 0;
    for (const binding of bindings.sort((a, b) => compare(a.subjectId, b.subjectId))) {
      const manifest = verifiedManifest(await input.reader.readManifest(binding), binding, limits.maxManifestBytes);
      const entries = new Map(manifest.entries.map(entry => [entry.path, entry])), refusals: RepositoryEvaluationRefusal[] = [];
      const refuse = (code: string, path?: string) => refusals.push(Object.freeze({ code, ...(path === undefined ? {} : { path }) }));
      if (!runner) refuse("TRUSTED_RUNNER_UNAVAILABLE");
      if (binding.availability !== "MATERIALIZED") refuse("SUBJECT_DECLARATION_ONLY");
      if (!["directory", "git"].includes(binding.subjectKind)) refuse("SUBJECT_LAYOUT_UNSUPPORTED");
      const tests = manifest.entries.filter(entry => isTest(entry.path));
      if (!tests.length) refuse("NO_DISCOVERED_NODE_TESTS");
      for (const entry of tests) if (!/\.[cm]?js$/u.test(entry.path)) refuse("TEST_LANGUAGE_UNSUPPORTED", entry.path);
      for (const entry of manifest.entries) if (unsupportedConfig(entry.path)) refuse("DEPENDENCY_OR_CUSTOM_CONFIG_UNSUPPORTED", entry.path);
      // Omitted tests are unavailable, not silently a smaller passing suite.
      for (const omission of manifest.omissions) if (omission.path && (isTest(omission.path) || /(?:^|\/)(?:test|tests)$/u.test(omission.path))) refuse("TEST_MATERIAL_OMITTED");
      const files = new Map<string, RepositoryEvaluationFile>(), configs = new Map<string, RepositoryEvaluationFile>();
      const texts = new Map<string, string>();
      const readText = async (entry: SubjectMaterialEntry): Promise<string | undefined> => {
        if (texts.has(entry.path)) return texts.get(entry.path)!;
        if (entry.byteLength > limits.maxFileBytes || bytesRead + entry.byteLength > limits.maxTotalBytes || sourceFileCount >= limits.maxSourceFiles) { refuse("SOURCE_BUDGET", entry.path); return undefined; }
        bytesRead += entry.byteLength; sourceFileCount++;
        const bytes = await input.reader.readBlob(entry.blobDigest, entry.byteLength);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== entry.byteLength || sha256Digest(bytes) !== entry.blobDigest) throw safeError();
        let text: string; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { refuse("SOURCE_NOT_UTF8", entry.path); return undefined; }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) { refuse("SOURCE_BINARY", entry.path); return undefined; }
        texts.set(entry.path, text); files.set(entry.path, metadata(entry)); return text;
      };
      let packageType: "module" | "commonjs" | undefined;
      for (const entry of manifest.entries.filter(entry => /(?:^|\/)package\.json$/u.test(entry.path))) {
        configs.set(entry.path, metadata(entry));
        if (entry.path !== "package.json") { refuse("NESTED_PACKAGE_SCOPE_UNSUPPORTED", entry.path); continue; }
        const text = await readText(entry); if (text === undefined) continue;
        let pkg: unknown; try { pkg = parseJsonText(text, "sealed package metadata"); } catch { refuse("PACKAGE_METADATA_INVALID", entry.path); continue; }
        if (!object(pkg)) { refuse("PACKAGE_METADATA_INVALID", entry.path); continue; }
        if (pkg.type !== undefined && pkg.type !== "module" && pkg.type !== "commonjs") refuse("PACKAGE_TYPE_UNSUPPORTED", entry.path);
        else packageType = pkg.type as typeof packageType;
        for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) if (pkg[key] !== undefined && (!object(pkg[key]) || Object.keys(pkg[key]).length > 0)) refuse("DEPENDENCY_DECLARATION_UNSUPPORTED", entry.path);
        if (pkg.imports !== undefined || pkg.workspaces !== undefined || pkg.babel !== undefined || pkg.jest !== undefined) refuse("PACKAGE_RESOLUTION_UNSUPPORTED", entry.path);
        if (pkg.scripts !== undefined) {
          if (!object(pkg.scripts)) refuse("PACKAGE_SCRIPTS_INVALID", entry.path);
          else {
            if (pkg.scripts.pretest !== undefined || pkg.scripts.posttest !== undefined) refuse("TEST_LIFECYCLE_HOOK_UNSUPPORTED", entry.path);
            if (pkg.scripts.test !== undefined && pkg.scripts.test !== "node --test") refuse("TEST_SCRIPT_UNSUPPORTED", entry.path);
          }
        }
      }
      if (plannedTestCount + tests.length > limits.maxTestFiles) refuse("TEST_FILE_BUDGET");
      const selectedTests = tests.slice(0, Math.max(0, limits.maxTestFiles - plannedTestCount)); plannedTestCount += selectedTests.length;
      const queue = selectedTests.map(entry => entry.path), visited = new Set<string>();
      while (queue.length) {
        const path = queue.shift()!; if (visited.has(path)) continue; visited.add(path);
        const entry = entries.get(path); if (!entry) { refuse("IMPORT_MATERIAL_UNAVAILABLE", path); continue; }
        const text = await readText(entry); if (text === undefined) continue;
        if (!/\.[cm]?js$/u.test(path)) { refuse("SOURCE_LANGUAGE_UNSUPPORTED", path); continue; }
        const syntax = await inspectSource(text, limits.maxSyntaxNodes);
        if (syntax.refusal) { refuse(syntax.refusal, path); continue; }
        if (syntax.moduleSyntax && (path.endsWith(".cjs") || path.endsWith(".js") && packageType !== "module")) refuse("AMBIGUOUS_MODULE_TYPE", path);
        if (selectedTests.some(test => test.path === path) && !syntax.hasNodeTests) refuse("NO_NODE_TEST_DECLARATION", path);
        for (const specifier of syntax.imports) {
          if (specifier !== "test" && BUILTINS.has(specifier.replace(/^node:/u, ""))) continue;
          if (!specifier.startsWith("./") && !specifier.startsWith("../")) { refuse("EXTERNAL_OR_UNSUPPORTED_IMPORT", path); continue; }
          const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
          if (!safePath(resolved) || !entries.has(resolved)) { refuse("IMPORT_MATERIAL_UNAVAILABLE", path); continue; }
          queue.push(resolved);
        }
      }
      const sorted = (values: Iterable<RepositoryEvaluationFile>) => Object.freeze([...values].sort((a, b) => compare(a.path, b.path)));
      const testFiles = sorted(selectedTests.map(metadata)), sourceFiles = sorted(files.values()), configFiles = sorted(configs.values());
      const uniqueRefusals = Object.freeze([...new Map(refusals.map(refusal => [hash(refusal), refusal])).values()].sort((a, b) => compare(a.code, b.code) || compare(a.path ?? "", b.path ?? "")));
      const payload = { discovery: REPOSITORY_EVALUATION_DISCOVERY, captureDigest: input.captureDigest, subjectId: binding.subjectId, manifestDigest: binding.manifestDigest, testFiles, sourceFiles, configFiles, runner: runner ?? null };
      subjects.push(Object.freeze({ subjectId: binding.subjectId, manifestDigest: binding.manifestDigest, status: uniqueRefusals.length ? "unavailable" : "ready", suiteDigest: hash(payload), testFiles, sourceFiles, configFiles,
        discoveredTestFiles: tests.length, authority: obligations.length === 1 && bindings.length === 1 && uniqueRefusals.length === 0 ? "intent-bound" : "comparative-only", obligationIds: Object.freeze(obligations.length === 1 && bindings.length === 1 && uniqueRefusals.length === 0 ? [obligations[0]!.id] : []), ...(runner ? { runner } : {}), refusals: uniqueRefusals }));
    }
    const ready = subjects.filter(subject => subject.status === "ready"), discovered = subjects.reduce((sum, subject) => sum + subject.discoveredTestFiles, 0), planned = ready.reduce((sum, subject) => sum + subject.testFiles.length, 0);
    const body = { protocol: REPOSITORY_EVALUATION_PLAN_PROTOCOL, discovery: REPOSITORY_EVALUATION_DISCOVERY, captureDigest: input.captureDigest, intentContractDigest: contract.digest, scope: "exact-existing-test-suite" as const, target: "sealed-original-subject" as const,
      status: ready.length === subjects.length && ready.length > 0 ? "ready" as const : ready.length > 0 ? "partial" as const : "unavailable" as const, subjects: Object.freeze(subjects), coverage: Object.freeze({ subjects: subjects.length, discoveredTestFiles: discovered, plannedTestFiles: planned, omittedTestFiles: discovered - planned }), limits };
    return Object.freeze({ ...body, digest: hash(body) });
  } catch { throw safeError(); }
}

/** Parsing/consistency only. A caller must independently authenticate the
 * controller, exact suite, target, event stream and invocation before using a
 * result. Model/subject JSON with these fields is never execution authority. */
export function checkRepositorySuiteReportConsistency(report: unknown, expectedSuiteDigest: string): { readonly consistent: boolean; readonly outcome: "pass" | "fail" | "unproven"; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  const fields = ["protocol", "suiteDigest", "complete", "executedTests", "passed", "failed", "errors", "skipped", "cancelled", "fileOnlyPasses"];
  if (!object(report) || Object.keys(report).sort().join() !== fields.sort().join()) return { consistent: false, outcome: "unproven", reasons: ["REPORT_SHAPE"] };
  if (report.protocol !== "jevyr.repository-suite-controller-report/1" || report.suiteDigest !== expectedSuiteDigest || !isSha256Digest(expectedSuiteDigest)) reasons.push("REPORT_IDENTITY");
  if (report.complete !== true) reasons.push("INCOMPLETE_REPORT");
  if (["executedTests", "passed", "failed", "errors", "skipped", "cancelled", "fileOnlyPasses"].some(field => !integer(report[field], 0, 1_000_000))) reasons.push("REPORT_COUNTS");
  if (reasons.length) return { consistent: false, outcome: "unproven", reasons };
  const counts = report as Record<string, number>;
  if (counts.executedTests !== counts.passed! + counts.failed! + counts.errors! + counts.skipped! + counts.cancelled!) reasons.push("REPORT_COUNT_SUM");
  if (counts.executedTests === 0 || counts.passed! + counts.failed! === 0) reasons.push("NO_EXECUTED_TESTS");
  if (counts.fileOnlyPasses! > 0) reasons.push("FILE_ONLY_SYNTHETIC_PASS");
  if (counts.skipped! > 0 || counts.cancelled! > 0 || counts.errors! > 0) reasons.push("INCOMPLETE_TEST_EXECUTION");
  return { consistent: reasons.length === 0, outcome: reasons.length ? "unproven" : counts.failed! > 0 ? "fail" : "pass", reasons };
}
