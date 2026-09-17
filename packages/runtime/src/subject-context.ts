import { canonicalize, digestJson, isSha256Digest, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { normalizeJevyrRelativePath } from "./ignore-policy.js";
import { SUBJECT_MATERIAL_CAPTURE_PROTOCOL, SUBJECT_MATERIAL_PROTOCOL, type SubjectMaterialBinding, type SubjectMaterialEntry, type SubjectMaterialManifest } from "./subject-materials.js";
import type { RepositoryEvaluationPlan } from "./repository-evaluation-plan.js";
import type { SourceInspectionFile, SourceReadReceipt } from "./task-source-inspection.js";

export const SUBJECT_CONTEXT_PROTOCOL = "jevyr.subject-context/1" as const;
export const SUBJECT_CONTEXT_LIMITS = Object.freeze({ maxFileBytes: 4 * 1024 * 1024, maxFiles: 4096, maxScanBytes: 16 * 1024 * 1024, maxResultBytes: 32_000, maxLines: 80, maxPageFiles: 128, maxMatches: 30 });
export type SubjectContextLimits = typeof SUBJECT_CONTEXT_LIMITS;
export interface SubjectContextReader {
  readManifest(binding: SubjectMaterialBinding): Promise<SubjectMaterialManifest>;
  readBlob(digest: string, expectedBytes: number): Promise<Uint8Array>;
}
export interface SubjectContextDescriptor {
  readonly protocol: typeof SUBJECT_CONTEXT_PROTOCOL;
  readonly captureDigest: string;
  readonly catalogDigest: string;
  /** Selected, addressable entries. Binary and empty entries remain honest metadata. */
  readonly totalFiles: number;
  readonly eligibleFiles: number;
  readonly omissionCount: number;
  readonly omissionDigest: string;
  readonly omissionCounts: Readonly<{ policy: number; perFileLimit: number; catalogLimit: number }>;
  /** Completeness concerns the permitted size-bounded catalog, not source sufficiency. */
  readonly complete: boolean;
  readonly catalogComplete: boolean;
  /** Classification is a bounded initial inspection; unknown files may be read later. */
  readonly readableFiles: number;
  readonly binaryFiles: number;
  readonly emptyFiles: number;
  readonly uninspectedFiles: number;
  readonly inspectionComplete: boolean;
  readonly limits: SubjectContextLimits;
}
export interface SubjectContextObservation { readonly value: JsonValue; readonly sourceDigests: readonly string[]; readonly sourceRead?: SourceReadReceipt }
export interface SubjectContext {
  readonly descriptor: SubjectContextDescriptor;
  /** Runtime-only metadata for bounded explicit task references; never source evidence. */
  readonly inspectionCatalog?: readonly SourceInspectionFile[];
  /** Optional verified discovery metadata. It never grants an evaluator or proof. */
  readonly repositoryEvaluationPlan?: RepositoryEvaluationPlan;
  listFiles(parameters: { readonly offset?: number; readonly limit?: number }): Promise<SubjectContextObservation>;
  readLines(parameters: { readonly fileId: string; readonly startLine: number; readonly endLine: number }): Promise<SubjectContextObservation>;
  search(parameters: { readonly query: string; readonly offset?: number; readonly startLine?: number }): Promise<SubjectContextObservation>;
}
export interface SubjectContextInput {
  readonly captureDigest: string;
  readonly bindings: readonly SubjectMaterialBinding[];
  readonly privacy: "full_case" | "provider_scoped" | "local_only";
  readonly providerNetwork: "none" | "loopback" | "provider" | "unrestricted";
  readonly reader: SubjectContextReader;
  readonly limits?: Partial<SubjectContextLimits>;
}
type Classification = "readable" | "binary" | "empty" | "uninspected";
interface CatalogEntry {
  readonly fileId: string;
  readonly subjectId: string;
  readonly path: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  /** Synthetic location inside an admitted OCI cell, never a live host path. */
  readonly ociReadOnlyPath: string;
  readonly classification: Classification;
  readonly totalLines: number | null;
  readonly completeReadFits: boolean;
}
interface InternalEntry { readonly binding: SubjectMaterialBinding; readonly entry: SubjectMaterialEntry; readonly public: CatalogEntry }
export type SubjectContextDenialCode = "UNAVAILABLE_CONTEXT" | "UNKNOWN_FILE" | "INVALID_RANGE" | "EMPTY_RANGE" | "RESULT_LIMIT";
export class SubjectContextRefusal extends TypeError {
  constructor(readonly denialCode: SubjectContextDenialCode = "UNAVAILABLE_CONTEXT") { super("Malformed, unavailable, or oversized sealed subject context"); }
}
const safeError = (code?: SubjectContextDenialCode) => new SubjectContextRefusal(code);
const json = (value: unknown) => value as JsonValue;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function exactParameters(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw safeError();
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw safeError();
  return value;
}
function relativePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096 || /[:\\\u0000-\u001f\u007f]/u.test(value)
    || normalizeJevyrRelativePath(value) !== value) throw safeError();
}
function boundedResult(value: unknown, limits: SubjectContextLimits, digests: readonly string[] = [], sourceRead?: SourceReadReceipt): SubjectContextObservation {
  if (Buffer.byteLength(JSON.stringify(value)) > limits.maxResultBytes) throw safeError("RESULT_LIMIT");
  return Object.freeze({ value: json(value), sourceDigests: Object.freeze([...new Set(digests)].sort(compare)), ...(sourceRead ? { sourceRead: Object.freeze(sourceRead) } : {}) });
}
/** The display range may normalize CRLF. Its digest is never a substitute for
 * the exact captured-file digest, even when every line has been inspected. */
function sourceRange(file: Pick<CatalogEntry,"fileId"|"sourceDigest"|"sourceByteLength"|"ociReadOnlyPath">, source: string, start: number, end: number) {
  const lines=source.split(/\r?\n/u), endLine=Math.min(end,lines.length),text=lines.slice(start-1,end).join("\n"),completeFile=start===1&&endLine===lines.length;
  const textDigest=sha256Digest(text);
  return {fileId:file.fileId,sourceDigest:file.sourceDigest,sourceByteLength:file.sourceByteLength,ociReadOnlyPath:file.ociReadOnlyPath,
    startLine:start,endLine,totalLines:lines.length,completeFile,text,textDigest,textByteLength:Buffer.byteLength(text),textNormalization:"CRLF_TO_LF",
    textNormalized:text!==source.split("\n").slice(start-1,end).join("\n"),textMatchesSourceBytes:completeFile&&textDigest===file.sourceDigest};
}
function classify(bytes: Uint8Array): { classification: Exclude<Classification, "uninspected">; text?: string } {
  if (bytes.byteLength === 0) return { classification: "empty" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return { classification: "binary" };
    return { classification: "readable", text };
  } catch { return { classification: "binary" }; }
}
function validateManifest(manifest: SubjectMaterialManifest, binding: SubjectMaterialBinding): SubjectMaterialManifest {
  const bytes = canonicalize(json(manifest));
  if (Buffer.byteLength(bytes) > 16 * 1024 * 1024 || sha256Digest(bytes) !== binding.manifestDigest
    || manifest.protocol !== SUBJECT_MATERIAL_PROTOCOL || manifest.subjectId !== binding.subjectId || manifest.subjectKind !== binding.subjectKind
    || manifest.subjectDigest !== binding.subjectDigest || manifest.availability !== binding.availability || manifest.byteLength !== binding.byteLength
    || !Array.isArray(manifest.entries) || !Array.isArray(manifest.directories) || !Array.isArray(manifest.omissions)) throw safeError();
  let prior = "", total = 0;
  for (const entry of manifest.entries) {
    relativePath(entry.path);
    if (compare(prior, entry.path) >= 0 || !isSha256Digest(entry.blobDigest)) throw safeError();
    integer(entry.byteLength, 0, Number.MAX_SAFE_INTEGER); integer(entry.mode, 0, 0o777);
    total += entry.byteLength; integer(total, 0, Number.MAX_SAFE_INTEGER); prior = entry.path;
  }
  for (const path of manifest.directories) relativePath(path);
  for (const omission of manifest.omissions) {
    if (typeof omission.reason !== "string" || omission.reason.length > 128) throw safeError();
    if (omission.path !== undefined) relativePath(omission.path);
  }
  if (total !== binding.byteLength || (binding.availability === "DECLARATION_ONLY" && total !== 0)) throw safeError();
  // Clone metadata before returning. The reader cannot mutate the verified catalog later.
  return JSON.parse(bytes) as SubjectMaterialManifest;
}

/** A bounded read-only capability over already sealed private CAS bytes. It has no
 * filesystem locator, network resolver, write operation, or authority over assays. */
export async function createSubjectContext(input: SubjectContextInput): Promise<SubjectContext | undefined> {
  // Refuse disclosure before metadata, blob, or locator resolution of any kind.
  if ((input.privacy === "provider_scoped" || input.privacy === "local_only") && (input.providerNetwork === "provider" || input.providerNetwork === "unrestricted")) return undefined;
  if (!["full_case", "provider_scoped", "local_only"].includes(input.privacy) || !["none", "loopback", "provider", "unrestricted"].includes(input.providerNetwork)) throw safeError();
  try {
    const limits = Object.freeze(Object.fromEntries(Object.entries(SUBJECT_CONTEXT_LIMITS).map(([key, ceiling]) => [key, integer(input.limits?.[key as keyof SubjectContextLimits] ?? ceiling, key === "maxResultBytes" ? 1024 : 1, ceiling)]))) as SubjectContextLimits;
    if (limits.maxFileBytes > limits.maxScanBytes || (input.limits && Object.keys(input.limits).some(key => !(key in SUBJECT_CONTEXT_LIMITS)))) throw safeError();
    if (!isSha256Digest(input.captureDigest) || !Array.isArray(input.bindings) || input.bindings.length > 256
      || digestJson({ protocol: SUBJECT_MATERIAL_CAPTURE_PROTOCOL, bindings: json(input.bindings) }) !== input.captureDigest) throw safeError();
    const bindings = JSON.parse(canonicalize(json(input.bindings))) as SubjectMaterialBinding[];
    const ids = new Set<string>();
    for (const binding of bindings) {
      if (typeof binding.subjectId !== "string" || binding.subjectId.trim() !== binding.subjectId || binding.subjectId.length === 0 || Buffer.byteLength(binding.subjectId) > 4096 || /[\u0000-\u001f\u007f]/u.test(binding.subjectId) || ids.has(binding.subjectId)
        || !isSha256Digest(binding.subjectDigest) || !isSha256Digest(binding.manifestDigest)
        || !["MATERIALIZED", "DECLARATION_ONLY"].includes(binding.availability)) throw safeError();
      integer(binding.byteLength, 0, Number.MAX_SAFE_INTEGER); ids.add(binding.subjectId); Object.freeze(binding);
    }
    bindings.sort((a, b) => compare(a.subjectId, b.subjectId));
    const reader = input.reader, captureDigest = input.captureDigest;
    const readManifest = async (binding: SubjectMaterialBinding) => validateManifest(await reader.readManifest(binding), binding);
    const verifiedBytes = async (file: Pick<InternalEntry, "binding" | "entry">, verifiedManifests = new Map<string, SubjectMaterialManifest>()): Promise<Uint8Array> => {
      // One fresh manifest read per binding per operation, without caching source
      // between calls or rereading an entire manifest for each catalog entry.
      let manifest = verifiedManifests.get(file.binding.manifestDigest);
      if (!manifest) { manifest = await readManifest(file.binding); verifiedManifests.set(file.binding.manifestDigest, manifest); }
      if (!manifest.entries.some(entry => entry.path === file.entry.path && entry.blobDigest === file.entry.blobDigest && entry.byteLength === file.entry.byteLength)) throw safeError();
      const bytes = await reader.readBlob(file.entry.blobDigest, file.entry.byteLength);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== file.entry.byteLength || sha256Digest(bytes) !== file.entry.blobDigest) throw safeError();
      return bytes;
    };
    const selected: InternalEntry[] = [], omissions: JsonValue[] = [];
    let eligibleFiles = 0, policy = 0, perFileLimit = 0, catalogLimit = 0, scanBytes = 0, manifestBytes = 0;
    let readableFiles = 0, binaryFiles = 0, emptyFiles = 0, uninspectedFiles = 0;
    for (const [bindingIndex, binding] of bindings.entries()) {
      const manifest = await readManifest(binding);
      manifestBytes += Buffer.byteLength(canonicalize(json(manifest)));
      if (manifestBytes > 64 * 1024 * 1024) throw safeError();
      policy += manifest.omissions.length;
      for (const omitted of manifest.omissions) omissions.push({ subjectId: binding.subjectId, omissionDigest: digestJson(json(omitted)), reason: "policy" });
      const verifiedManifests = new Map([[binding.manifestDigest, manifest]]);
      const omittedPaths = new Set(manifest.omissions.flatMap(omission => omission.path === undefined ? [] : [omission.path]));
      for (const entry of manifest.entries) {
        // An explicit omission cannot be reintroduced by a conflicting manifest entry.
        const segments = entry.path.split("/");
        if (segments.some((_, index) => omittedPaths.has(segments.slice(0, index + 1).join("/")))) throw safeError();
        if (entry.byteLength > limits.maxFileBytes) { perFileLimit++; omissions.push({ subjectId: binding.subjectId, path: entry.path, sourceDigest: entry.blobDigest, reason: "perFileLimit" }); continue; }
        eligibleFiles++;
        if (selected.length >= limits.maxFiles) { catalogLimit++; omissions.push({ subjectId: binding.subjectId, path: entry.path, sourceDigest: entry.blobDigest, reason: "catalogLimit" }); continue; }
        let classification: Classification = "uninspected", inspectedText: string | undefined;
        if (scanBytes + entry.byteLength <= limits.maxScanBytes) {
          scanBytes += entry.byteLength;
          const classified = classify(await verifiedBytes({ binding, entry }, verifiedManifests));
          classification = classified.classification; inspectedText = classified.text;
        }
        if (classification === "readable") readableFiles++; else if (classification === "binary") binaryFiles++; else if (classification === "empty") emptyFiles++; else uninspectedFiles++;
        const path = entry.path, subjectId = binding.subjectId, sourceDigest = entry.blobDigest;
        // Materialization uses the same sorted binding ordinal, including gaps
        // for declaration-only subjects. Catalog limits never renumber mounts.
        const ociReadOnlyPath = `/subject/subject-${bindingIndex.toString().padStart(4, "0")}/${path}`;
        const fileId = digestJson({ subjectId, path, sourceDigest }), lines = inspectedText?.split(/\r?\n/u), totalLines = lines?.length ?? null;
        const completeReadFits = lines !== undefined && lines.length <= limits.maxLines && Buffer.byteLength(JSON.stringify(sourceRange({fileId,sourceDigest,sourceByteLength:entry.byteLength,ociReadOnlyPath},inspectedText!,1,lines.length))) <= limits.maxResultBytes;
        selected.push(Object.freeze({ binding, entry: Object.freeze(entry), public: Object.freeze({ fileId, subjectId, path, sourceDigest, sourceByteLength: entry.byteLength, ociReadOnlyPath, classification, totalLines, completeReadFits }) }));
      }
    }
    const catalog = Object.freeze(selected.map(file => file.public)), byId = new Map(selected.map(file => [file.public.fileId, file]));
    const omissionCounts = Object.freeze({ policy, perFileLimit, catalogLimit });
    const catalogComplete = perFileLimit === 0 && catalogLimit === 0;
    const descriptor: SubjectContextDescriptor = Object.freeze({ protocol: SUBJECT_CONTEXT_PROTOCOL, captureDigest, catalogDigest: digestJson({ captureDigest, files: json(catalog), limits: json(limits) }), totalFiles: selected.length, eligibleFiles, omissionCount: policy + perFileLimit + catalogLimit, omissionDigest: digestJson(omissions), omissionCounts, complete: catalogComplete, catalogComplete, readableFiles, binaryFiles, emptyFiles, uninspectedFiles, inspectionComplete: uninspectedFiles === 0, limits });
    const checkedText = async (file: InternalEntry): Promise<string> => {
      const value = classify(await verifiedBytes(file));
      if (value.classification !== "readable" || value.text === undefined) throw safeError();
      return value.text;
    };
    const guard = async (operation: () => Promise<SubjectContextObservation>) => { try { return await operation(); } catch(error) { throw error instanceof SubjectContextRefusal ? error : safeError(); } };
    return Object.freeze({
      descriptor,
      inspectionCatalog: catalog,
      listFiles: (parameters: { offset?: number; limit?: number }) => guard(async () => {
        exactParameters(parameters, ["offset", "limit"]);
        const offset = integer(Object.hasOwn(parameters, "offset") ? parameters.offset : 0, 0, catalog.length);
        const limit = integer(Object.hasOwn(parameters, "limit") ? parameters.limit : Math.min(64, limits.maxPageFiles), 1, limits.maxPageFiles);
        const files: CatalogEntry[] = [];
        const page = (entries: readonly CatalogEntry[]) => ({ availability: "SEALED_CAPTURE", captureDigest, catalogDigest: descriptor.catalogDigest, files: entries, offset, limit, total: catalog.length, nextOffset: offset + entries.length < catalog.length ? offset + entries.length : null, complete: catalogComplete });
        for (const file of catalog.slice(offset, offset + limit)) { if (Buffer.byteLength(JSON.stringify(page([...files, file]))) > limits.maxResultBytes) break; files.push(file); }
        if (!files.length && offset < catalog.length) throw safeError();
        return boundedResult(page(files), limits);
      }),
      readLines: (parameters: { fileId: string; startLine: number; endLine: number }) => guard(async () => {
        exactParameters(parameters, ["fileId", "startLine", "endLine"]);
        if (typeof parameters.fileId !== "string") throw safeError();
        const file = byId.get(parameters.fileId); if (!file) throw safeError("UNKNOWN_FILE");
        let start:number,end:number;
        try {start=integer(parameters.startLine,1,Number.MAX_SAFE_INTEGER);end=integer(parameters.endLine,start,Math.min(Number.MAX_SAFE_INTEGER,start+limits.maxLines-1));}catch{throw safeError("INVALID_RANGE");}
        const displayed=sourceRange(file.public,await checkedText(file),start,end),{text,endLine,totalLines,completeFile}=displayed;
        if (start > totalLines || Buffer.byteLength(text) === 0) throw safeError("EMPTY_RANGE");
        return boundedResult(displayed, limits, [file.public.sourceDigest], {
          catalogDigest: descriptor.catalogDigest, fileId: file.public.fileId, sourceDigest: file.public.sourceDigest, sourceByteLength: file.public.sourceByteLength,
          textDigest: displayed.textDigest, startLine: start, endLine, totalLines, completeFile,
        });
      }),
      search: (parameters: { query: string; offset?: number; startLine?: number }) => guard(async () => {
        exactParameters(parameters, ["query", "offset", "startLine"]);
        if (typeof parameters.query !== "string" || parameters.query.length < 1 || parameters.query.length > 256) throw safeError();
        const offset = integer(Object.hasOwn(parameters, "offset") ? parameters.offset : 0, 0, selected.length);
        const startLine = integer(Object.hasOwn(parameters, "startLine") ? parameters.startLine : 1, 1, Number.MAX_SAFE_INTEGER);
        const matches: { fileId: string; sourceDigest: string; ociReadOnlyPath: string; line: number; text: string; excerptStart: number; excerptPartial: boolean }[] = [];
        let scannedBytes = 0, scannedFiles = 0, next: { offset: number; startLine: number } | null = null;
        const verifiedManifests = new Map<string, SubjectMaterialManifest>();
        const result = () => ({ matches, offset, startLine, scannedFiles, scannedBytes, truncated: next !== null, next, nextOffset: next?.offset ?? null, scope: "permitted-sealed-text-only", catalogComplete });
        outer: for (let fileIndex = offset; fileIndex < selected.length; fileIndex++) {
          const file = selected[fileIndex]!;
          if (scannedBytes + file.entry.byteLength > limits.maxScanBytes) { next = { offset: fileIndex, startLine: 1 }; break; }
          scannedBytes += file.entry.byteLength; scannedFiles++;
          const value = classify(await verifiedBytes(file, verifiedManifests));
          if (value.classification !== "readable" || value.text === undefined) continue;
          const lines = value.text.split(/\r?\n/u);
          for (let lineIndex = fileIndex === offset ? startLine - 1 : 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex]!, found = line.indexOf(parameters.query); if (found < 0) continue;
            const excerptStart = Math.max(0, found - 128), text = line.slice(excerptStart, excerptStart + 512);
            const match = { fileId: file.public.fileId, sourceDigest: file.public.sourceDigest, ociReadOnlyPath: file.public.ociReadOnlyPath, line: lineIndex + 1, text, excerptStart, excerptPartial: excerptStart > 0 || excerptStart + text.length < line.length };
            matches.push(match);
            // Reserve cursor overhead before accepting an excerpt.
            next = { offset: fileIndex, startLine: lineIndex + 2 };
            if (Buffer.byteLength(JSON.stringify(result())) > limits.maxResultBytes) { matches.pop(); next = { offset: fileIndex, startLine: lineIndex + 1 }; if (!matches.length) throw safeError(); break outer; }
            if (matches.length >= limits.maxMatches) {
              next = lineIndex + 1 < lines.length ? { offset: fileIndex, startLine: lineIndex + 2 } : fileIndex + 1 < selected.length ? { offset: fileIndex + 1, startLine: 1 } : null;
              break outer;
            }
            next = null;
          }
        }
        return boundedResult(result(), limits, matches.map(match => match.sourceDigest));
      }),
    });
  } catch { throw safeError(); }
}
