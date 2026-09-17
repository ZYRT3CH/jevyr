import { canonicalize, digestJson, isSha256Digest, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { parseJsonBytes } from "@jevyr/core";
import { analyzeRepositoryPureAssertionContext, decodeRepositoryPureAssertionContext, REPOSITORY_PURE_ASSERTION_LIMITS, type RepositoryPureAssertionAnalysis, type RepositoryPureAssertionContext, type RepositoryPureAssertionLimits } from "./repository-pure-assertions.js";
import type { RepositoryEvaluatorRunner } from "./repository-evaluation-plan.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "./subject-materials.js";

export const REPOSITORY_PURE_PRODUCER_ROOT = "/subject/repository-pure" as const;
export const REPOSITORY_PURE_PRODUCER_ENTRY = `${REPOSITORY_PURE_PRODUCER_ROOT}/producer.mjs` as const;
export const REPOSITORY_PURE_PRODUCER_ARGV = Object.freeze([REPOSITORY_PURE_PRODUCER_ENTRY]);
export const REPOSITORY_PURE_PRODUCER_LIMITS = Object.freeze({ maxRequestBytes: 128 * 1024, maxManifestBytes: 1024 * 1024, maxBlobBytes: 256 * 1024,
  maxBlobTotalBytes: 256 * 1024, maxBlobs: 256, maxAssetBytes: 2 * 1024 * 1024, maxPackageBytes: 8 * 1024 * 1024, maxEntries: 1024, maxResultBytes: 8 * 1024 * 1024 + 4096 });
export interface PureProducerFile { readonly path: string; readonly digest: string; readonly byteLength: number }
export interface RepositoryPureProducerImplementation {
  readonly protocol: "jevyr.repository-pure-producer-implementation/1";
  readonly format: "node24-esm-bundle";
  readonly entryPath: typeof REPOSITORY_PURE_PRODUCER_ENTRY;
  readonly requestPath: "/subject/repository-pure/request.json";
  readonly argv: readonly string[];
  readonly bundler: Readonly<{ name: "esbuild"; version: string; apiDigest: string; binaryDigest: string; optionsDigest: string }>;
  readonly inputs: readonly PureProducerFile[];
  readonly transforms: readonly Readonly<{ path: string; kind: "fixed-grammar-url/1"; originalDigest: string; transformedDigest: string }>[];
  readonly assets: readonly PureProducerFile[];
  readonly limits: typeof REPOSITORY_PURE_PRODUCER_LIMITS;
  readonly digest: string;
}
export interface RepositoryPureProducerRequest {
  readonly protocol: "jevyr.repository-pure-producer-request/1";
  readonly implementationDigest: string;
  readonly context: RepositoryPureAssertionContext;
  readonly bindings: readonly SubjectMaterialBinding[];
  readonly runner: RepositoryEvaluatorRunner;
  readonly limits: RepositoryPureAssertionLimits;
  readonly manifests: readonly PureProducerFile[];
  readonly blobs: readonly PureProducerFile[];
}
export interface RepositoryPureProducerResult {
  readonly protocol: "jevyr.repository-pure-producer-result/1";
  readonly implementationDigest: string; readonly requestDigest: string;
  readonly analysis: RepositoryPureAssertionAnalysis; readonly digest: string;
}
export interface RepositoryPureProducerPackageDescriptor {
  readonly protocol: "jevyr.repository-pure-producer-package/1";
  readonly scope: "fixed-pure-evaluator-and-captured-data";
  readonly implementationDigest: string; readonly requestDigest: string; readonly contextDigest: string;
  readonly entries: readonly (Readonly<{ path: string; type: "directory" }> | Readonly<{ path: string; type: "file"; digest: string; byteLength: number }>)[];
  readonly forgeTreeDigest: string; readonly byteLength: number; readonly maximumFileBytes: number; readonly fileCount: number;
  readonly mountReadOnlyRequired: true; readonly digest: string;
}
const hash = (value: unknown) => digestJson(value as JsonValue);
export const pureProducerBytes = (value: unknown): Buffer => Buffer.from(canonicalize(value as JsonValue));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function fields(value: unknown, names: string): asserts value is Record<string, unknown> { if (!object(value) || Object.keys(value).sort().join() !== names) throw new TypeError("Pure producer data shape refused"); }
function bounded(value: unknown, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
export function freezePureProducer<T>(value: T): T { if (value && typeof value === "object") { for (const item of Object.values(value)) freezePureProducer(item); Object.freeze(value); } return value; }
export function pureProducerPath(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._/-]{1,512}$/u.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}
function fileList(value: unknown, maxCount: number, maxBytes: number): asserts value is readonly PureProducerFile[] {
  if (!Array.isArray(value) || value.length > maxCount) throw new TypeError("Pure producer inventory bound refused");
  let prior = "";
  for (const file of value) {
    fields(file, "byteLength,digest,path");
    if (typeof file.path !== "string" || !pureProducerPath(file.path) || file.path <= prior || !isSha256Digest(file.digest) || !bounded(file.byteLength, maxBytes)) throw new TypeError("Pure producer inventory refused");
    prior = file.path;
  }
}
export function decodeRepositoryPureProducerImplementation(bytes: Uint8Array): RepositoryPureProducerImplementation {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > REPOSITORY_PURE_PRODUCER_LIMITS.maxManifestBytes) throw new TypeError("Pure producer implementation bound refused");
  const value = parseJsonBytes(bytes); fields(value, "argv,assets,bundler,digest,entryPath,format,inputs,limits,protocol,requestPath,transforms");
  fields(value.bundler, "apiDigest,binaryDigest,name,optionsDigest,version");
  if (value.protocol !== "jevyr.repository-pure-producer-implementation/1" || value.format !== "node24-esm-bundle" || value.entryPath !== REPOSITORY_PURE_PRODUCER_ENTRY
    || value.requestPath !== `${REPOSITORY_PURE_PRODUCER_ROOT}/request.json` || hash(value.argv) !== hash(REPOSITORY_PURE_PRODUCER_ARGV) || hash(value.limits) !== hash(REPOSITORY_PURE_PRODUCER_LIMITS)
    || value.bundler.name !== "esbuild" || typeof value.bundler.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(value.bundler.version)
    || [value.bundler.apiDigest, value.bundler.binaryDigest, value.bundler.optionsDigest, value.digest].some(item => !isSha256Digest(item))) throw new TypeError("Pure producer implementation identity refused");
  fileList(value.inputs, 256, 32 * 1024 * 1024); fileList(value.assets, 3, REPOSITORY_PURE_PRODUCER_LIMITS.maxAssetBytes);
  if (value.assets.map(file => file.path).join() !== "producer.mjs,tree-sitter-javascript.wasm,tree-sitter.wasm" || !Array.isArray(value.transforms) || value.transforms.length !== 2) throw new TypeError("Pure producer asset set refused");
  for (const entry of value.transforms) {
    fields(entry, "kind,originalDigest,path,transformedDigest");
    if (entry.kind !== "fixed-grammar-url/1" || !/^runtime\/repository-(?:pure-assertions|evaluation-plan)\.(?:ts|js)$/u.test(String(entry.path))
      || !isSha256Digest(entry.originalDigest) || !isSha256Digest(entry.transformedDigest) || !value.inputs.some(file => file.path === entry.path && file.digest === entry.originalDigest)) throw new TypeError("Pure producer transform refused");
  }
  const transformPaths = value.transforms.map(entry => String((entry as Record<string, unknown>).path)).sort();
  if (!["ts", "js"].some(extension => transformPaths.join() === `runtime/repository-evaluation-plan.${extension},runtime/repository-pure-assertions.${extension}`)) throw new TypeError("Pure producer transform coverage refused");
  const { digest, ...body } = value;
  if (hash(body) !== digest || !Buffer.from(bytes).equals(pureProducerBytes(value))) throw new TypeError("Pure producer implementation encoding refused");
  return freezePureProducer(value as unknown as RepositoryPureProducerImplementation);
}
export function decodeRepositoryPureProducerRequest(bytes: Uint8Array, implementation: RepositoryPureProducerImplementation): RepositoryPureProducerRequest {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > REPOSITORY_PURE_PRODUCER_LIMITS.maxRequestBytes) throw new TypeError("Pure producer request bound refused");
  const value = parseJsonBytes(bytes); fields(value, "bindings,blobs,context,implementationDigest,limits,manifests,protocol,runner");
  const context = decodeRepositoryPureAssertionContext(value.context);
  if (value.protocol !== "jevyr.repository-pure-producer-request/1" || value.implementationDigest !== implementation.digest || !Array.isArray(value.bindings) || value.bindings.length !== 1) throw new TypeError("Pure producer request identity refused");
  fields(value.runner, "capabilityId,evaluatorDigest,id,immutableImageId");
  if (value.runner.id !== "node-test-v1" || !isSha256Digest(value.runner.evaluatorDigest) || !isSha256Digest(value.runner.immutableImageId)
    || typeof value.runner.capabilityId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/u.test(value.runner.capabilityId)) throw new TypeError("Pure producer discovery identity refused");
  fields(value.limits, Object.keys(REPOSITORY_PURE_ASSERTION_LIMITS).sort().join());
  for (const [key, maximum] of Object.entries(REPOSITORY_PURE_ASSERTION_LIMITS)) if (!bounded(value.limits[key], maximum) || !["maxFunctions", "maxParameters"].includes(key) && value.limits[key] === 0) throw new TypeError("Pure producer analysis limit refused");
  fileList(value.manifests, 1, REPOSITORY_PURE_PRODUCER_LIMITS.maxManifestBytes); fileList(value.blobs, REPOSITORY_PURE_PRODUCER_LIMITS.maxBlobs, REPOSITORY_PURE_PRODUCER_LIMITS.maxBlobBytes);
  if (value.manifests.length !== 1 || value.blobs.reduce((sum, file) => sum + file.byteLength, 0) > REPOSITORY_PURE_PRODUCER_LIMITS.maxBlobTotalBytes) throw new TypeError("Pure producer data bound refused");
  const binding = value.bindings[0]; fields(binding, "availability,byteLength,manifestDigest,subjectDigest,subjectId,subjectKind");
  if (binding.availability !== "MATERIALIZED" || binding.subjectKind !== "directory" || !isSha256Digest(binding.manifestDigest) || value.manifests[0]!.digest !== binding.manifestDigest
    || !isSha256Digest(binding.subjectDigest) || typeof binding.subjectId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/u.test(binding.subjectId) || !bounded(binding.byteLength, Number.MAX_SAFE_INTEGER)
    || context.subject.subjectId !== binding.subjectId || context.subject.digest !== binding.subjectDigest || context.subject.byteLength !== binding.byteLength
    || context.captureDigest !== hash({ protocol: "jevyr.subject-material-capture/1", bindings: value.bindings })) throw new TypeError("Pure producer capture binding refused");
  for (const file of value.manifests) if (file.path !== `data/manifests/${file.digest.slice(7)}.json`) throw new TypeError("Pure producer manifest path refused");
  for (const file of value.blobs) if (file.path !== `data/blobs/${file.digest.slice(7)}.blob`) throw new TypeError("Pure producer blob path refused");
  if (!Buffer.from(bytes).equals(pureProducerBytes(value))) throw new TypeError("Pure producer request encoding refused");
  return freezePureProducer(value as unknown as RepositoryPureProducerRequest);
}
/** Uses only declared digest-addressed sidecars. The callback must enforce plain,
 * bounded reads below its dedicated package root; no Case locator is resolved. */
export async function reconstructRepositoryPureProducerResult(request: RepositoryPureProducerRequest, read: (file: PureProducerFile) => Promise<Uint8Array>): Promise<RepositoryPureProducerResult> {
  const manifests = new Map(request.manifests.map(file => [file.digest, file])), blobs = new Map(request.blobs.map(file => [file.digest, file]));
  const readExact = async (file: PureProducerFile | undefined): Promise<Uint8Array> => {
    if (!file) throw new TypeError("Pure producer undeclared data refused"); const bytes = await read(file);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== file.byteLength || sha256Digest(bytes) !== file.digest) throw new TypeError("Pure producer data hash refused"); return Buffer.from(bytes);
  };
  const analysis = await analyzeRepositoryPureAssertionContext({ context: request.context, bindings: request.bindings, runner: request.runner, limits: request.limits, reader: {
    readManifest: async binding => parseJsonBytes(await readExact(manifests.get(binding.manifestDigest))) as SubjectMaterialManifest,
    readBlob: async (digest, expectedBytes) => { const file = blobs.get(digest); if (!file || file.byteLength !== expectedBytes) throw new TypeError("Pure producer undeclared blob refused"); return readExact(file); },
  } });
  const body = { protocol: "jevyr.repository-pure-producer-result/1" as const, implementationDigest: request.implementationDigest, requestDigest: hash(request), analysis };
  const result = freezePureProducer({ ...body, digest: hash(body) });
  if (pureProducerBytes(result).length > REPOSITORY_PURE_PRODUCER_LIMITS.maxResultBytes) throw new TypeError("Pure producer result bound refused"); return result;
}
export function deriveRepositoryPureProducerPackageDescriptor(implementation: RepositoryPureProducerImplementation, request: RepositoryPureProducerRequest): RepositoryPureProducerPackageDescriptor {
  const files = [...implementation.assets, ...request.manifests, ...request.blobs,
    { path: "implementation.json", digest: hash(implementation), byteLength: pureProducerBytes(implementation).length },
    { path: "request.json", digest: hash(request), byteLength: pureProducerBytes(request).length }];
  const directories = new Set(["repository-pure"]), seen = new Set<string>();
  for (const file of files) {
    if (!pureProducerPath(file.path) || seen.has(file.path.toLowerCase())) throw new TypeError("Pure producer package path refused"); seen.add(file.path.toLowerCase());
    const parts = `repository-pure/${file.path}`.split("/"); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const entries: RepositoryPureProducerPackageDescriptor["entries"][number][] = [...directories].map(path => ({ path, type: "directory" as const }));
  entries.push(...files.map(file => ({ ...file, path: `repository-pure/${file.path}`, type: "file" as const }))); entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(entries.map(entry => entry.path.toLowerCase())).size !== entries.length) throw new TypeError("Pure producer package collision refused");
  const byteLength = files.reduce((sum, file) => sum + file.byteLength, 0);
  if (byteLength > REPOSITORY_PURE_PRODUCER_LIMITS.maxPackageBytes || entries.length > REPOSITORY_PURE_PRODUCER_LIMITS.maxEntries) throw new TypeError("Pure producer package bound refused");
  const body = { protocol: "jevyr.repository-pure-producer-package/1" as const, scope: "fixed-pure-evaluator-and-captured-data" as const,
    implementationDigest: implementation.digest, requestDigest: hash(request), contextDigest: request.context.digest, entries,
    forgeTreeDigest: hash({ protocol: "jevyr.directory-manifest/1", entries }), byteLength, maximumFileBytes: Math.max(...files.map(file => file.byteLength)), fileCount: files.length, mountReadOnlyRequired: true as const };
  return freezePureProducer({ ...body, digest: hash(body) });
}
