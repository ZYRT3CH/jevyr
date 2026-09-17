import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonicalize, digestJson, isSha256Digest, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { REPOSITORY_EVALUATION_DISCOVERY, REPOSITORY_EVALUATION_LIMITS, type RepositoryEvaluationFile, type RepositorySubjectEvaluation } from "./repository-evaluation-plan.js";
import type { SubjectContextReader } from "./subject-context.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "./subject-materials.js";

export const REPOSITORY_EVALUATION_CLOSURE_PROTOCOL = "jevyr.repository-evaluation-closure/1" as const;
export const REPOSITORY_EVALUATION_CLOSURE_ROOT = "/subject/repository-evaluation/closure" as const;
export interface RepositoryEvaluationClosureFile extends RepositoryEvaluationFile {
  readonly materializedMode: number;
  readonly roles: readonly ("test" | "source" | "config")[];
  readonly original: Readonly<{ subjectId: string; manifestDigest: string; entryIndex: number; path: string; digest: string; bytes: number; mode: number }>;
}
export interface RepositoryEvaluationClosure {
  readonly protocol: typeof REPOSITORY_EVALUATION_CLOSURE_PROTOCOL;
  readonly target: "sealed-original-subject";
  readonly scope: "selected-static-test-closure";
  readonly captureDigest: string;
  readonly subjectId: string;
  readonly subjectDigest: string;
  readonly manifestDigest: string;
  readonly suiteDigest: string;
  readonly files: readonly RepositoryEvaluationClosureFile[];
  readonly directories: readonly string[];
  readonly byteLength: number;
  readonly treeDigest: string;
  readonly membershipDigest: string;
  readonly mountReadOnlyRequired: true;
  readonly materializationDigest: string;
}
export interface RepositoryEvaluationClosureInput {
  readonly captureDigest: string;
  readonly bindings: readonly SubjectMaterialBinding[];
  readonly reader: SubjectContextReader;
  /** Independently derived plan, not a model-supplied selection. Membership is
   * checked here too; a caller still must authenticate the complete plan. */
  readonly subject: RepositorySubjectEvaluation;
}
const json = (value: unknown) => value as JsonValue;
const hash = (value: unknown) => digestJson(json(value));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const refuse = () => new TypeError("Repository evaluation closure refused invalid, changed, linked, or unavailable material");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 && !/[:\\\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function portablePath(value: string): void {
  if (!safePath(value) || value.split("/").some(part => /[. ]$/u.test(part) || /[<>"|?*]/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw refuse();
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}
function checkedManifest(value: SubjectMaterialManifest, binding: SubjectMaterialBinding): SubjectMaterialManifest {
  const encoded = canonicalize(json(value));
  if (Buffer.byteLength(encoded) > REPOSITORY_EVALUATION_LIMITS.maxManifestBytes || sha256Digest(encoded) !== binding.manifestDigest
    || value.protocol !== "jevyr.subject-material/1" || value.subjectId !== binding.subjectId || value.subjectKind !== binding.subjectKind
    || value.subjectDigest !== binding.subjectDigest || value.availability !== "MATERIALIZED" || binding.availability !== "MATERIALIZED"
    || value.byteLength !== binding.byteLength || !Array.isArray(value.entries) || !Array.isArray(value.directories) || !Array.isArray(value.omissions)) throw refuse();
  let prior = "", total = 0;
  for (const entry of value.entries) {
    if (!safePath(entry.path) || compare(prior, entry.path) >= 0 || !isSha256Digest(entry.blobDigest)
      || !integer(entry.byteLength, Number.MAX_SAFE_INTEGER) || !integer(entry.mode, 0o777)) throw refuse();
    prior = entry.path; total += entry.byteLength;
  }
  if (!Number.isSafeInteger(total) || total !== binding.byteLength || value.directories.some(path => !safePath(path))
    || value.omissions.some(item => !object(item) || typeof item.reason !== "string" || item.path !== undefined && !safePath(item.path))) throw refuse();
  return JSON.parse(encoded) as SubjectMaterialManifest;
}
async function prepare(input: RepositoryEvaluationClosureInput): Promise<{ descriptor: RepositoryEvaluationClosure; contents: ReadonlyMap<string, Buffer> }> {
  if (!isSha256Digest(input.captureDigest) || !Array.isArray(input.bindings) || input.bindings.length > 256
    || hash({ protocol: "jevyr.subject-material-capture/1", bindings: input.bindings }) !== input.captureDigest) throw refuse();
  const bindings = JSON.parse(canonicalize(json(input.bindings))) as SubjectMaterialBinding[];
  const subject = JSON.parse(canonicalize(json(input.subject))) as RepositorySubjectEvaluation;
  if (new Set(bindings.map(item => item.subjectId)).size !== bindings.length || subject.status !== "ready" || subject.refusals.length || !subject.runner
    || !subject.testFiles.length || subject.discoveredTestFiles !== subject.testFiles.length || subject.testFiles.length > REPOSITORY_EVALUATION_LIMITS.maxTestFiles) throw refuse();
  const binding = bindings.find(item => item.subjectId === subject.subjectId);
  if (!binding || !isSha256Digest(binding.subjectDigest) || binding.manifestDigest !== subject.manifestDigest || !integer(binding.byteLength, Number.MAX_SAFE_INTEGER)) throw refuse();
  const manifest = checkedManifest(await input.reader.readManifest(freeze(binding)), binding);
  const suite = { discovery: REPOSITORY_EVALUATION_DISCOVERY, captureDigest: input.captureDigest, subjectId: binding.subjectId, manifestDigest: binding.manifestDigest,
    testFiles: subject.testFiles, sourceFiles: subject.sourceFiles, configFiles: subject.configFiles, runner: subject.runner };
  if (hash(suite) !== subject.suiteDigest) throw refuse();
  const selected = new Map<string, { file: RepositoryEvaluationFile; roles: ("test" | "source" | "config")[] }>();
  for (const [role, list] of [["test", subject.testFiles], ["source", subject.sourceFiles], ["config", subject.configFiles]] as const) {
    if (!Array.isArray(list) || list.length > REPOSITORY_EVALUATION_LIMITS.maxSourceFiles) throw refuse();
    let prior = "";
    for (const file of list) {
      if (!object(file) || Object.keys(file).sort().join() !== "bytes,digest,path" || !safePath(file.path) || compare(prior, file.path) >= 0
        || !isSha256Digest(file.digest) || !integer(file.bytes, REPOSITORY_EVALUATION_LIMITS.maxFileBytes)) throw refuse();
      portablePath(file.path); prior = file.path;
      const previous = selected.get(file.path);
      if (previous && hash(previous.file) !== hash(file)) throw refuse();
      if (previous) previous.roles.push(role); else selected.set(file.path, { file: { path: file.path, digest: file.digest, bytes: file.bytes }, roles: [role] });
    }
  }
  if (selected.size > REPOSITORY_EVALUATION_LIMITS.maxSourceFiles) throw refuse();
  const directories = new Set<string>(), aliases = new Map<string, string>(), files: RepositoryEvaluationClosureFile[] = [], contents = new Map<string, Buffer>();
  const entryMap = new Map(manifest.entries.map((entry, index) => [entry.path, { entry, index }]));
  let byteLength = 0;
  for (const [path, selection] of [...selected].sort(([a], [b]) => compare(a, b))) {
    const source = entryMap.get(path), file = selection.file;
    if (!source || source.entry.blobDigest !== file.digest || source.entry.byteLength !== file.bytes
      || manifest.omissions.some(item => item.path && (path === item.path || path.startsWith(`${item.path}/`)))) throw refuse();
    byteLength += file.bytes; if (byteLength > REPOSITORY_EVALUATION_LIMITS.maxTotalBytes) throw refuse();
    const parts = path.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const name = parts.slice(0, count).join("/"), alias = name.toLowerCase();
      if (aliases.has(alias) && aliases.get(alias) !== name) throw refuse(); aliases.set(alias, name);
      if (count < parts.length) { if (selected.has(name)) throw refuse(); directories.add(name); }
    }
    const raw = await input.reader.readBlob(file.digest, file.bytes);
    if (!(raw instanceof Uint8Array) || raw.byteLength !== file.bytes || sha256Digest(raw) !== file.digest) throw refuse();
    // Copy immediately: a mutable store view cannot change bytes after validation.
    contents.set(path, Buffer.from(raw));
    files.push({ ...file, materializedMode: source.entry.mode & 0o111 ? 0o555 : 0o444, roles: selection.roles.sort(compare),
      original: { subjectId: binding.subjectId, manifestDigest: binding.manifestDigest, entryIndex: source.index, path, digest: file.digest, bytes: file.bytes, mode: source.entry.mode } });
  }
  const sortedDirectories = [...directories].sort(compare);
  const treeDigest = hash({ protocol: "jevyr.repository-evaluation-tree/1", files: files.map(({ path, digest, bytes }) => ({ path, digest, bytes })), directories: sortedDirectories });
  const membershipDigest = hash({ protocol: "jevyr.repository-evaluation-membership/1", captureDigest: input.captureDigest, subjectId: binding.subjectId,
    subjectDigest: binding.subjectDigest, manifestDigest: binding.manifestDigest, suiteDigest: subject.suiteDigest, files: files.map(file => file.original) });
  const body = { protocol: REPOSITORY_EVALUATION_CLOSURE_PROTOCOL, target: "sealed-original-subject" as const, scope: "selected-static-test-closure" as const,
    captureDigest: input.captureDigest, subjectId: binding.subjectId, subjectDigest: binding.subjectDigest, manifestDigest: binding.manifestDigest, suiteDigest: subject.suiteDigest,
    files, directories: sortedDirectories, byteLength, treeDigest, membershipDigest, mountReadOnlyRequired: true as const };
  return { descriptor: freeze({ ...body, materializationDigest: hash(body) }), contents };
}

/** Rederives exact selected-source membership and bytes, with no filesystem write,
 * execution, complete-subject materialization claim, or verdict authority. */
export async function deriveRepositoryEvaluationClosure(input: RepositoryEvaluationClosureInput): Promise<RepositoryEvaluationClosure> {
  try { return (await prepare(input)).descriptor; } catch { throw refuse(); }
}
async function noLinkedAncestors(path: string): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let cursor = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part); const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw refuse();
  }
  const actual = await realpath(absolute);
  if (process.platform === "win32" ? actual.toLowerCase() !== absolute.toLowerCase() : actual !== absolute) throw refuse();
}
async function verifyOutput(root: string, descriptor: RepositoryEvaluationClosure): Promise<void> {
  await noLinkedAncestors(root);
  const expected = new Map(descriptor.files.map(file => [file.path, file])), foundFiles: string[] = [], foundDirs: string[] = [];
  const visit = async (relativeDirectory: string): Promise<void> => {
    const path = relativeDirectory ? join(root, ...relativeDirectory.split("/")) : root;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name, child = join(path, entry.name), info = await lstat(child);
      if (info.isSymbolicLink()) throw refuse();
      if (info.isDirectory()) { if (!descriptor.directories.includes(relativePath)) throw refuse(); foundDirs.push(relativePath); await visit(relativePath); continue; }
      const file = expected.get(relativePath);
      if (!info.isFile() || info.nlink !== 1 || !file || info.size !== file.bytes || (info.mode & 0o222) !== 0) throw refuse();
      const handle = await open(child, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes || before.dev !== info.dev || before.ino !== info.ino) throw refuse();
        const buffer = Buffer.alloc(file.bytes + 1); let read = 0;
        while (read < buffer.length) { const next = await handle.read(buffer, read, buffer.length - read, read); if (!next.bytesRead) break; read += next.bytesRead; }
        const after = await handle.stat();
        if (read !== file.bytes || sha256Digest(buffer.subarray(0, read)) !== file.digest || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw refuse();
      } finally { await handle.close(); }
      foundFiles.push(relativePath);
    }
  };
  await visit("");
  if (hash(foundFiles.sort(compare)) !== hash(descriptor.files.map(file => file.path)) || hash(foundDirs.sort(compare)) !== hash(descriptor.directories)) throw refuse();
}

/** Creates a fresh, exact selected closure without executing source or linking
 * CAS files. Host permissions are hardened; Forge must separately enforce a
 * read-only mount and verify the closure before and after execution. A failed
 * copy is never published and remains in its new caller-owned destination. */
export async function materializeRepositoryEvaluationClosure(input: RepositoryEvaluationClosureInput, destination: string): Promise<{ readonly root: string; readonly descriptor: RepositoryEvaluationClosure }> {
  try {
    if (!isAbsolute(destination) || /[\u0000-\u001f\u007f]/u.test(destination)) throw refuse();
    const root = resolve(destination); if (root === parse(root).root) throw refuse();
    await noLinkedAncestors(dirname(root));
    const { descriptor, contents } = await prepare(input);
    await mkdir(root, { recursive: false, mode: 0o700 });
    for (const directory of descriptor.directories) {
      const path = join(root, ...directory.split("/")); await noLinkedAncestors(dirname(path)); await mkdir(path, { recursive: false, mode: 0o700 });
    }
    for (const file of descriptor.files) {
      const path = join(root, ...file.path.split("/")); await noLinkedAncestors(dirname(path));
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(contents.get(file.path)!); await handle.sync(); } finally { await handle.close(); }
      await chmod(path, file.materializedMode);
    }
    for (const directory of [...descriptor.directories].reverse()) await chmod(join(root, ...directory.split("/")), 0o555);
    await chmod(root, 0o555); await verifyOutput(root, descriptor);
    return Object.freeze({ root, descriptor });
  } catch { throw refuse(); }
}
