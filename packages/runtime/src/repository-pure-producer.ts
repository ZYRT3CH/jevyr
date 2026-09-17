import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalize, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { parseJsonBytes } from "@jevyr/core";
import { analyzeRepositoryPureAssertions, deriveRepositoryPureAssertionContext, REPOSITORY_PURE_ASSERTION_LIMITS, type RepositoryPureAssertionInput } from "./repository-pure-assertions.js";
import { decodeRepositoryPureProducerImplementation, decodeRepositoryPureProducerRequest, deriveRepositoryPureProducerPackageDescriptor, freezePureProducer,
  pureProducerBytes, pureProducerPath, reconstructRepositoryPureProducerResult, REPOSITORY_PURE_PRODUCER_ARGV, REPOSITORY_PURE_PRODUCER_ENTRY,
  REPOSITORY_PURE_PRODUCER_LIMITS, REPOSITORY_PURE_PRODUCER_ROOT, type PureProducerFile, type RepositoryPureProducerImplementation,
  type RepositoryPureProducerPackageDescriptor, type RepositoryPureProducerRequest, type RepositoryPureProducerResult } from "./repository-pure-producer-data.js";
import type { SubjectMaterialManifest } from "./subject-materials.js";
import { BUILT_REPOSITORY_PURE_PRODUCER_DESCRIPTOR_DIGEST } from "./repository-pure-assets-pin.js";
export type { RepositoryPureProducerImplementation, RepositoryPureProducerPackageDescriptor, RepositoryPureProducerRequest, RepositoryPureProducerResult } from "./repository-pure-producer-data.js";

export interface RepositoryPureProducerAssets {
  readonly descriptor: RepositoryPureProducerImplementation;
  /** Detached copies. Mutating returned bytes cannot change the private package. */
  files(): readonly Readonly<{ path: string; bytes: Uint8Array }>[];
}
export interface RepositoryPureProducerPackage {
  readonly request: RepositoryPureProducerRequest;
  readonly requestBytes: Uint8Array;
  readonly expectedResult: RepositoryPureProducerResult;
  readonly descriptor: RepositoryPureProducerPackageDescriptor;
  /** Complete /subject-relative file inventory, including fixed assets and data. */
  files(): readonly Readonly<{ path: string; bytes: Uint8Array }>[];
}
const require = createRequire(import.meta.url), moduleFile = fileURLToPath(import.meta.url), moduleDirectory = dirname(moduleFile);
const LOADED_BUILDER_BYTES = readFileSync(moduleFile);
const privateAssets = new WeakMap<RepositoryPureProducerAssets, ReadonlyMap<string, Buffer>>();
const privateAssetInputs = new WeakMap<RepositoryPureProducerAssets, ReadonlyMap<string, Buffer>>();
const privatePackages = new WeakMap<RepositoryPureProducerPackage, ReadonlyMap<string, Buffer>>();
const FACADE_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  core: 'export {compileIntentContract,assertIntentContract} from "pure-source:core/intent"; export {parseJsonText,parseJsonBytes} from "pure-source:core/json";',
  protocol: 'export * from "pure-source:protocol/canonical"; export * from "pure-source:protocol/types"; export * from "pure-source:protocol/validation";',
});
function fail(): never { throw new TypeError("Pure producer package refused unavailable, changed, unbranded or out-of-bound material"); }
const metadata = (path: string, bytes: Uint8Array): PureProducerFile => ({ path, digest: sha256Digest(bytes), byteLength: bytes.byteLength });
const sorted = <T extends { path: string }>(files: readonly T[]): T[] => [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
function copyFiles(files: ReadonlyMap<string, Buffer>): readonly Readonly<{ path: string; bytes: Uint8Array }>[] {
  return Object.freeze(sorted([...files].map(([path, bytes]) => Object.freeze({ path, bytes: Buffer.from(bytes) }))));
}
export function assertRepositoryPureProducerAssets(value: RepositoryPureProducerAssets): void { if (!privateAssets.has(value)) fail(); }
interface BuildResult { outputFiles?: { contents: Uint8Array }[]; metafile?: { outputs: Record<string, { imports: { path: string; external?: boolean }[] }> } }
interface BuildAPI { version: string; build(options: Record<string, unknown>): Promise<BuildResult> }
interface PluginAPI { onResolve(options: { filter: RegExp }, callback: (args: { path: string; importer: string; namespace: string }) => unknown): void;
  onLoad(options: { filter: RegExp; namespace?: string }, callback: (args: { path: string; namespace: string }) => unknown): void }

/** Uses the already installed esbuild shipped with tsx. No installation, remote
 * fetch, package script or subject repository participates in trusted bundling. */
export async function createRepositoryPureProducerAssets(): Promise<RepositoryPureProducerAssets> {
  if (process.env.ESBUILD_BINARY_PATH) fail();
  const tsxRequire = createRequire(require.resolve("tsx")), esbuildPath = tsxRequire.resolve("esbuild"), esbuildRequire = createRequire(esbuildPath);
  const buildAPI = esbuildRequire(esbuildPath) as BuildAPI;
  const binaryPath = esbuildRequire.resolve(process.platform === "win32" ? `@esbuild/win32-${process.arch}/esbuild.exe` : `@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
  const apiBytes = readFileSync(esbuildPath), binaryBytes = readFileSync(binaryPath);
  const extension = moduleFile.endsWith(".ts") ? "ts" : "js";
  const coreDirectory = dirname(require.resolve("@jevyr/core")), protocolDirectory = dirname(require.resolve("@jevyr/protocol"));
  const coreExtension = coreDirectory.endsWith(`${sep}src`) ? "ts" : "js", protocolExtension = protocolDirectory.endsWith(`${sep}src`) ? "ts" : "js";
  const treeDirectory = dirname(require.resolve("web-tree-sitter")), grammarPath = require.resolve("tree-sitter-wasms/out/tree-sitter-javascript.wasm");
  const wasmBytes = readFileSync(join(treeDirectory, "tree-sitter.wasm")), grammarBytes = readFileSync(grammarPath);
  const inputs = new Map<string, Buffer>(), transforms: RepositoryPureProducerImplementation["transforms"][number][] = [];
  const sourcePaths: Readonly<Record<string, string>> = Object.freeze({
    "core/intent": join(coreDirectory, `intent.${coreExtension}`), "core/json": join(coreDirectory, `json.${coreExtension}`),
    "protocol/canonical": join(protocolDirectory, `canonical.${protocolExtension}`), "protocol/types": join(protocolDirectory, `types.${protocolExtension}`), "protocol/validation": join(protocolDirectory, `validation.${protocolExtension}`),
  });
  const logical = (path: string): string => {
    for (const [prefix, directory] of [["runtime", moduleDirectory], ["core", coreDirectory], ["protocol", protocolDirectory], ["npm/web-tree-sitter", treeDirectory]] as const) {
      const rel = relative(directory, path); if (rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) return `${prefix}/${rel.replaceAll(sep, "/")}`;
    }
    return fail();
  };
  inputs.set(`runtime/repository-pure-producer.${extension}`, Buffer.from(LOADED_BUILDER_BYTES));
  inputs.set("build/esbuild-api.js", apiBytes); inputs.set("build/esbuild-native", binaryBytes);
  inputs.set("npm/web-tree-sitter/package.json", readFileSync(join(treeDirectory, "package.json")));
  inputs.set("npm/tree-sitter-wasms/package.json", readFileSync(join(dirname(dirname(grammarPath)), "package.json")));
  inputs.set("npm/web-tree-sitter/tree-sitter.wasm", wasmBytes); inputs.set("npm/tree-sitter-wasms/tree-sitter-javascript.wasm", grammarBytes);
  const options = { platform: "node", format: "esm", target: "node24", bundle: true, minify: false, sourcemap: false, legalComments: "none", treeShaking: true, conditions: ["import"], charset: "utf8" };
  const plugin = { name: "closed-pure-producer-inputs", setup(build: PluginAPI): void {
    build.onResolve({ filter: /^(?:@jevyr\/|pure-source:|web-tree-sitter$)/ }, args => {
      if (args.path === "@jevyr/core" || args.path === "@jevyr/protocol") return { path: args.path.slice(7), namespace: "pure-facade" };
      if (args.path === "web-tree-sitter") return { path: join(treeDirectory, "tree-sitter.js") };
      if (args.path.startsWith("pure-source:") && sourcePaths[args.path.slice(12)]) return { path: sourcePaths[args.path.slice(12)] };
      return fail();
    });
    build.onLoad({ filter: /.*/, namespace: "pure-facade" }, args => {
      const contents = FACADE_SOURCES[args.path] ?? fail(); inputs.set(`virtual/${args.path}-facade.js`, Buffer.from(contents)); return { contents, loader: "js" };
    });
    build.onLoad({ filter: /\.(?:[cm]?js|ts)$/ }, args => {
      const id = logical(args.path), original = readFileSync(args.path); if (original.length > 2 * 1024 * 1024) fail();
      const prior = inputs.get(id); if (prior && !prior.equals(original)) fail(); inputs.set(id, original);
      let contents = original.toString("utf8");
      if (/^runtime\/repository-(?:pure-assertions|evaluation-plan)\.(?:ts|js)$/u.test(id)) {
        const needle = 'require.resolve("tree-sitter-wasms/out/tree-sitter-javascript.wasm")';
        if (contents.split(needle).length !== 2) fail();
        contents = 'import {fileURLToPath as __pureGrammarPath} from "node:url";\n' + contents.replace(needle, '__pureGrammarPath(new URL("./tree-sitter-javascript.wasm",import.meta.url))');
        transforms.push({ path: id, kind: "fixed-grammar-url/1", originalDigest: sha256Digest(original), transformedDigest: sha256Digest(contents) });
      }
      return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js", resolveDir: dirname(args.path) };
    });
  } };
  const built = await buildAPI.build({ ...options, entryPoints: [join(moduleDirectory, `repository-pure-producer-runner.${extension}`)], absWorkingDir: resolve(moduleDirectory, "../../.."), outfile: "producer.mjs", write: false, metafile: true, logLevel: "silent", plugins: [plugin] });
  if (built.outputFiles?.length !== 1 || !built.metafile || transforms.length !== 2 || !readFileSync(esbuildPath).equals(apiBytes) || !readFileSync(binaryPath).equals(binaryBytes)) fail();
  for (const output of Object.values(built.metafile.outputs)) for (const imported of output.imports) if (!imported.external || !isBuiltin(imported.path)) fail();
  const files = new Map<string, Buffer>([["producer.mjs", Buffer.from(built.outputFiles[0]!.contents)], ["tree-sitter-javascript.wasm", Buffer.from(grammarBytes)], ["tree-sitter.wasm", Buffer.from(wasmBytes)]]);
  for (const bytes of files.values()) if (bytes.length > REPOSITORY_PURE_PRODUCER_LIMITS.maxAssetBytes) fail();
  const body = { protocol: "jevyr.repository-pure-producer-implementation/1" as const, format: "node24-esm-bundle" as const, entryPath: REPOSITORY_PURE_PRODUCER_ENTRY,
    requestPath: `${REPOSITORY_PURE_PRODUCER_ROOT}/request.json` as const, argv: REPOSITORY_PURE_PRODUCER_ARGV,
    bundler: { name: "esbuild" as const, version: buildAPI.version, apiDigest: sha256Digest(apiBytes), binaryDigest: sha256Digest(binaryBytes), optionsDigest: sha256Digest(pureProducerBytes(options)) },
    inputs: sorted([...inputs].map(([path, bytes]) => metadata(path, bytes))), transforms: sorted(transforms), assets: sorted([...files].map(([path, bytes]) => metadata(path, bytes))), limits: REPOSITORY_PURE_PRODUCER_LIMITS };
  const descriptor = decodeRepositoryPureProducerImplementation(pureProducerBytes({ ...body, digest: sha256Digest(pureProducerBytes(body)) }));
  const assets: RepositoryPureProducerAssets = Object.freeze({ descriptor, files: () => copyFiles(files) }); privateAssets.set(assets, files); privateAssetInputs.set(assets, inputs); return assets;
}

/** Build tooling exports detached installation bytes. Compiler provenance is
 * shipped for verification only; production never loads or executes it. */
export function repositoryPureProducerInstallationFiles(assets: RepositoryPureProducerAssets): readonly Readonly<{ path: string; bytes: Uint8Array }>[] {
  assertRepositoryPureProducerAssets(assets); const inputs = privateAssetInputs.get(assets) ?? fail();
  const files = new Map<string, Buffer>([["implementation.json", pureProducerBytes(assets.descriptor)], ...privateAssets.get(assets)!]);
  for (const input of assets.descriptor.inputs) if (input.path.startsWith("build/") || input.path.startsWith("virtual/")) {
    const bytes = inputs.get(input.path) ?? fail(); if (bytes.length !== input.byteLength || sha256Digest(bytes) !== input.digest) fail();
    files.set(`provenance/${input.digest.slice(7)}.bin`, Buffer.from(bytes));
  }
  return copyFiles(files);
}

function readInstalled(path: string, maximum: number, expectedBytes?: number): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || expectedBytes !== undefined && info.size !== expectedBytes) fail();
  const handle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(handle); if (before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) fail();
    const bytes = Buffer.alloc(info.size + 1); let used = 0;
    while (used < bytes.length) { const count = readSync(handle, bytes, used, bytes.length - used, used); if (!count) break; used += count; }
    const after = fstatSync(handle); if (used !== info.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) fail();
    return bytes.subarray(0, used);
  } finally { closeSync(handle); }
}

/** Synchronous, fixed-location loader for a built installation. Its generated
 * pin is installed trusted code, never a hash supplied by a Case or artifact.
 * All execution dependencies are checked locally; removed development tools
 * are represented by the exact shipped build-provenance bytes, never required. */
export function loadRepositoryPureProducerAssetsSync(): RepositoryPureProducerAssets {
  if (BUILT_REPOSITORY_PURE_PRODUCER_DESCRIPTOR_DIGEST === null || moduleFile.endsWith(".ts")) fail();
  const root = join(moduleDirectory, "repository-pure-assets"), info = lstatSync(root), physical = realpathSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform === "win32" ? physical.toLowerCase() !== resolve(root).toLowerCase() : physical !== resolve(root))) fail();
  const descriptor = decodeRepositoryPureProducerImplementation(readInstalled(join(root, "implementation.json"), REPOSITORY_PURE_PRODUCER_LIMITS.maxManifestBytes));
  if (descriptor.digest !== BUILT_REPOSITORY_PURE_PRODUCER_DESCRIPTOR_DIGEST || descriptor.inputs.reduce((sum, item) => sum + item.byteLength, 0) > 128 * 1024 * 1024) fail();
  const files = new Map<string, Buffer>(), inputs = new Map<string, Buffer>(), expected = new Set(["implementation.json", "provenance"]);
  const roots = { runtime: moduleDirectory, core: dirname(require.resolve("@jevyr/core")), protocol: dirname(require.resolve("@jevyr/protocol")),
    "npm/web-tree-sitter": dirname(require.resolve("web-tree-sitter")) };
  const grammarPath = require.resolve("tree-sitter-wasms/out/tree-sitter-javascript.wasm");
  for (const item of descriptor.assets) {
    const bytes = readInstalled(join(root, item.path), REPOSITORY_PURE_PRODUCER_LIMITS.maxAssetBytes, item.byteLength);
    if (sha256Digest(bytes) !== item.digest) fail(); files.set(item.path, bytes); expected.add(item.path);
  }
  for (const item of descriptor.inputs) {
    let bytes: Buffer | undefined;
    if (item.path.startsWith("build/") || item.path.startsWith("virtual/")) {
      const path = `provenance/${item.digest.slice(7)}.bin`; expected.add(path); bytes = readInstalled(join(root, ...path.split("/")), 32 * 1024 * 1024, item.byteLength);
      if (item.path.startsWith("virtual/")) {
        const name = item.path.slice("virtual/".length).replace(/-facade\.js$/u, ""), source = FACADE_SOURCES[name];
        if (source === undefined || !bytes.equals(Buffer.from(source))) fail();
      }
    } else if (item.path === "npm/tree-sitter-wasms/tree-sitter-javascript.wasm") bytes = readInstalled(grammarPath, 32 * 1024 * 1024, item.byteLength);
    else if (item.path === "npm/tree-sitter-wasms/package.json") bytes = readInstalled(join(dirname(dirname(grammarPath)), "package.json"), 32 * 1024 * 1024, item.byteLength);
    else for (const [prefix, base] of Object.entries(roots)) if (item.path.startsWith(`${prefix}/`)) {
      bytes = readInstalled(join(base, ...item.path.slice(prefix.length + 1).split("/")), 32 * 1024 * 1024, item.byteLength); break;
    }
    if (!bytes || sha256Digest(bytes) !== item.digest) fail(); inputs.set(item.path, bytes);
  }
  if (!inputs.get("runtime/repository-pure-producer.js")?.equals(LOADED_BUILDER_BYTES)) fail();
  const found = new Set<string>();
  const inventory = (directory: string): void => {
    for (const entry of readdirSync(directory ? join(root, directory) : root, { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (!pureProducerPath(path) || !expected.has(path) || found.has(path)) fail(); found.add(path);
      if (entry.isDirectory() && path === "provenance") inventory(path); else if (!entry.isFile()) fail();
    }
  };
  inventory(""); if (found.size !== expected.size) fail();
  const assets: RepositoryPureProducerAssets = Object.freeze({ descriptor, files: () => copyFiles(files) });
  privateAssets.set(assets, files); privateAssetInputs.set(assets, inputs); return assets;
}

/** The packaged path never invokes a compiler; source tools opt into building. */
export function repositoryPureProducerAssetsForCurrentBuild(): Promise<RepositoryPureProducerAssets> {
  return moduleFile.endsWith(".ts") ? createRepositoryPureProducerAssets() : Promise.resolve(loadRepositoryPureProducerAssetsSync());
}

/** Derives the host-path-free context from the original Case and records exactly
 * the immutable manifest/CAS reads needed by complete independent analysis. */
export async function prepareRepositoryPureProducerPackage(input: RepositoryPureAssertionInput, assets: RepositoryPureProducerAssets): Promise<RepositoryPureProducerPackage> {
  assertRepositoryPureProducerAssets(assets); const fixedAssets = privateAssets.get(assets)!;
  const context = deriveRepositoryPureAssertionContext(input.sealedCase), files = new Map<string, Buffer>(), manifests = new Map<string, Buffer>(), blobs = new Map<string, Buffer>();
  let captureReadFailed = false;
  const snapshotReader = {
    readManifest: async (binding: RepositoryPureAssertionInput["bindings"][number]): Promise<SubjectMaterialManifest> => {
      try {
      let bytes = manifests.get(binding.manifestDigest);
      if (!bytes) {
        const raw = await input.reader.readManifest(binding); bytes = pureProducerBytes(raw);
        if (bytes.length > REPOSITORY_PURE_PRODUCER_LIMITS.maxManifestBytes || sha256Digest(bytes) !== binding.manifestDigest) fail(); manifests.set(binding.manifestDigest, Buffer.from(bytes));
      }
      return parseJsonBytes(bytes) as SubjectMaterialManifest;
      } catch { captureReadFailed = true; return fail(); }
    },
    readBlob: async (digest: string, expectedBytes: number): Promise<Uint8Array> => {
      try {
      let bytes = blobs.get(digest);
      if (!bytes) {
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > REPOSITORY_PURE_PRODUCER_LIMITS.maxBlobBytes || blobs.size >= REPOSITORY_PURE_PRODUCER_LIMITS.maxBlobs) fail();
        const raw = await input.reader.readBlob(digest, expectedBytes); if (!(raw instanceof Uint8Array) || raw.byteLength !== expectedBytes || sha256Digest(raw) !== digest) fail();
        bytes = Buffer.from(raw); blobs.set(digest, bytes);
        if ([...blobs.values()].reduce((sum, value) => sum + value.length, 0) > REPOSITORY_PURE_PRODUCER_LIMITS.maxBlobTotalBytes) fail();
      }
      if (bytes.length !== expectedBytes) fail(); return Buffer.from(bytes);
      } catch { captureReadFailed = true; return fail(); }
    },
  };
  const analysis = await analyzeRepositoryPureAssertions({ ...input, reader: snapshotReader });
  // A missing manifest prevents complete request construction. Unsupported source
  // after captured reads can still produce an honest unavailable analysis.
  if (captureReadFailed || manifests.size !== 1) fail();
  const manifestFiles = sorted([...manifests].map(([digest, bytes]) => metadata(`data/manifests/${digest.slice(7)}.json`, bytes)));
  const blobFiles = sorted([...blobs].map(([digest, bytes]) => metadata(`data/blobs/${digest.slice(7)}.blob`, bytes)));
  const request = decodeRepositoryPureProducerRequest(pureProducerBytes({ protocol: "jevyr.repository-pure-producer-request/1", implementationDigest: assets.descriptor.digest,
    context, bindings: input.bindings, runner: input.runner, limits: analysis.limits, manifests: manifestFiles, blobs: blobFiles }), assets.descriptor);
  for (const [path, bytes] of fixedAssets) files.set(`repository-pure/${path}`, Buffer.from(bytes));
  for (const file of manifestFiles) files.set(`repository-pure/${file.path}`, Buffer.from(manifests.get(file.digest)!));
  for (const file of blobFiles) files.set(`repository-pure/${file.path}`, Buffer.from(blobs.get(file.digest)!));
  files.set("repository-pure/implementation.json", pureProducerBytes(assets.descriptor)); files.set("repository-pure/request.json", pureProducerBytes(request));
  const expectedResult = await reconstructRepositoryPureProducerResult(request, async file => Buffer.from(files.get(`repository-pure/${file.path}`) ?? fail()));
  if (canonicalize(expectedResult.analysis as unknown as JsonValue) !== canonicalize(analysis as unknown as JsonValue)) fail();
  const descriptor = deriveRepositoryPureProducerPackageDescriptor(assets.descriptor, request), requestBytes = pureProducerBytes(request);
  const prepared: RepositoryPureProducerPackage = Object.freeze({ request, get requestBytes() { return Buffer.from(requestBytes); }, expectedResult, descriptor, files: () => copyFiles(files) });
  privatePackages.set(prepared, files); return prepared;
}
async function checkedAncestors(path: string): Promise<void> {
  let cursor = resolve(path);
  while (true) { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) fail(); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  const physical = await realpath(path); if (process.platform === "win32" ? physical.toLowerCase() !== resolve(path).toLowerCase() : physical !== resolve(path)) fail();
}
async function checkMaterialized(root: string, descriptor: RepositoryPureProducerPackageDescriptor): Promise<void> {
  const expected = new Map(descriptor.entries.map(file => [file.path, file])), found = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory ? join(root, ...directory.split("/")) : root, { withFileTypes: true })) {
      const path = directory ? `${directory}/${item.name}` : item.name, entry = expected.get(path), absolute = join(root, ...path.split("/")), info = await lstat(absolute);
      if (!pureProducerPath(path) || !entry || info.isSymbolicLink() || found.has(path) || found.size >= REPOSITORY_PURE_PRODUCER_LIMITS.maxEntries) fail(); found.add(path);
      if (entry.type === "directory") { if (!info.isDirectory()) fail(); await walk(path); }
      else {
        if (!info.isFile() || info.nlink !== 1 || info.size !== entry.byteLength || (info.mode & 0o222) !== 0) fail();
        const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await handle.stat(); if (before.dev !== info.dev || before.ino !== info.ino || before.nlink !== 1 || before.size !== entry.byteLength) fail();
          const bytes = Buffer.alloc(entry.byteLength + 1); let used = 0;
          while (used < bytes.length) { const read = await handle.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
          const after = await handle.stat(); if (used !== entry.byteLength || after.size !== entry.byteLength || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || sha256Digest(bytes.subarray(0, used)) !== entry.digest) fail();
        } finally { await handle.close(); }
      }
    }
  };
  await checkedAncestors(root); await walk(""); if (found.size !== expected.size) fail();
}
/** A fresh dedicated /subject tree. It cannot append into an existing root or
 * materialize a shape-compatible caller object. No candidate workspace is made. */
export async function materializeRepositoryPureProducerPackage(prepared: RepositoryPureProducerPackage, destination: string): Promise<RepositoryPureProducerPackageDescriptor> {
  const files = privatePackages.get(prepared); if (!files || !isAbsolute(destination)) fail();
  const root = resolve(destination); await checkedAncestors(dirname(root)); await mkdir(root, { mode: 0o700 });
  await checkedAncestors(root);
  for (const entry of prepared.descriptor.entries) {
    if (!pureProducerPath(entry.path)) fail(); const path = join(root, ...entry.path.split("/"));
    if (entry.type === "directory") await mkdir(path, { mode: 0o700 });
    else {
      const bytes = files.get(entry.path); if (!bytes || bytes.length !== entry.byteLength || sha256Digest(bytes) !== entry.digest) fail();
      await checkedAncestors(dirname(path)); const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1) fail(); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await chmod(path, 0o444);
    }
  }
  for (const entry of [...prepared.descriptor.entries].reverse()) if (entry.type === "directory") await chmod(join(root, ...entry.path.split("/")), 0o555);
  await chmod(root, 0o555); await checkMaterialized(root, prepared.descriptor); return prepared.descriptor;
}
