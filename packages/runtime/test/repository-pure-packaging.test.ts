import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { canonicalize, digestJson, type JsonValue } from "@jevyr/protocol";
import { loadRepositoryPureProducerAssetsSync } from "../src/repository-pure-producer.js";

const require = createRequire(import.meta.url), linkType = process.platform === "win32" ? "junction" : "dir";
const moduleNames = ["repository-pure-producer", "repository-pure-assets-pin", "repository-pure-producer-data", "repository-pure-producer-runner", "repository-pure-assertions", "repository-evaluation-plan", "repository-evaluation-closure"];
async function child(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, args, { cwd, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: "" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { processChild.kill(); reject(new Error("Private producer packaging check timed out")); }, 60_000);
    processChild.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 2_000_000) { processChild.kill(); reject(new Error("Private producer stdout exceeded bound")); } });
    processChild.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 100_000) { processChild.kill(); reject(new Error("Private producer stderr exceeded bound")); } });
    processChild.on("error", error => { clearTimeout(timer); reject(error); });
    processChild.on("close", code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}
async function packaged<T>(run: (root: string, installed: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-pure-install-"));
  try {
    const build = join(root, "build"), installed = join(root, "installed"); await mkdir(build); await mkdir(installed);
    await writeFile(join(build, "package.json"), '{"type":"module"}'); await writeFile(join(installed, "package.json"), '{"type":"module"}');
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(build, "node_modules"), linkType);
    for (const name of moduleNames) {
      const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
      const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      await writeFile(join(build, `${name}.js`), output);
    }
    const built = await child(build, [fileURLToPath(new URL("../scripts/build-pure-producer.mjs", import.meta.url)), build]);
    assert.equal(built.code, 0, built.stderr); const buildReport = JSON.parse(built.stdout); assert.match(buildReport.descriptorDigest, /^sha256:/);
    for (const name of moduleNames) await cp(join(build, `${name}.js`), join(installed, `${name}.js`));
    await cp(join(build, "repository-pure-assets"), join(installed, "repository-pure-assets"), { recursive: true });
    await mkdir(join(installed, "node_modules", "@jevyr"), { recursive: true });
    for (const name of ["core", "protocol"]) await symlink(dirname(dirname(require.resolve(`@jevyr/${name}`))), join(installed, "node_modules", "@jevyr", name), linkType);
    // Copy only production parser dependencies. No tsx, TypeScript, esbuild,
    // package-manager binary or package-build hook exists in this installation.
    await cp(dirname(require.resolve("web-tree-sitter")), join(installed, "node_modules", "web-tree-sitter"), { recursive: true, dereference: true });
    await cp(dirname(dirname(require.resolve("tree-sitter-wasms/out/tree-sitter-javascript.wasm"))), join(installed, "node_modules", "tree-sitter-wasms"), { recursive: true, dereference: true });
    await writeFile(join(installed, "check.mjs"), `import assert from "node:assert/strict"; import {createRequire} from "node:module";
import {loadRepositoryPureProducerAssetsSync,assertRepositoryPureProducerAssets,repositoryPureProducerAssetsForCurrentBuild} from "./repository-pure-producer.js";
const require=createRequire(import.meta.url); for(const name of ["tsx","typescript","esbuild"])assert.throws(()=>require.resolve(name));
const assets=loadRepositoryPureProducerAssetsSync();assertRepositoryPureProducerAssets(assets);assert.equal(assets.descriptor.digest,${JSON.stringify(buildReport.descriptorDigest)});
assert.throws(()=>assertRepositoryPureProducerAssets({...assets}));const bytes=assets.files()[0].bytes;bytes.fill(0);assert.notDeepEqual(bytes,assets.files()[0].bytes);
assert.deepEqual((await repositoryPureProducerAssetsForCurrentBuild()).descriptor,assets.descriptor);process.stdout.write(JSON.stringify({valid:true,descriptorDigest:assets.descriptor.digest,files:assets.files().length}));`);
    return await run(root, installed);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); assert.ok(root.includes("jevyr-pure-install-"));
    await rm(root, { recursive: true, force: true });
  }
}

test("source loader refuses missing generated trusted build identity", () => { assert.throws(() => loadRepositoryPureProducerAssetsSync()); });

test("packaged producer loads synchronously after development dependencies are absent", { timeout: 120_000 }, async () => {
  await packaged(async (_root, installed) => {
    const result = await child(installed, [join(installed, "check.mjs")]);
    assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { valid: true, descriptorDigest: JSON.parse(result.stdout).descriptorDigest, files: 3 });
    assert.ok((await readdir(join(installed, "repository-pure-assets", "provenance"))).length >= 3);
  });
});

test("packaged loader refuses rehashed substitutions, dependency drift, missing provenance and extra files", { timeout: 120_000 }, async () => {
  await packaged(async (_root, installed) => {
    const assets = join(installed, "repository-pure-assets"), manifestPath = join(assets, "implementation.json"), manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString("utf8"));
    const altered = { ...manifest, assets: manifest.assets.map((item: { path: string }) => item.path === "producer.mjs" ? { ...item, digest: digestJson("replaced producer") } : item) };
    const { digest: _ignored, ...body } = altered; altered.digest = digestJson(body as JsonValue);
    for (const mutation of [
      { path: manifestPath, replacement: Buffer.from(canonicalize(altered as JsonValue)) },
      { path: join(assets, "producer.mjs"), replacement: Buffer.from("process.stdout.write('forged');") },
      { path: join(installed, "repository-pure-assertions.js"), replacement: Buffer.from("export const forged=true;") },
      { path: join(installed, "node_modules", "web-tree-sitter", "tree-sitter.wasm"), replacement: Buffer.from("changed parser bytes") },
      { path: join(assets, "provenance", `${manifest.inputs.find((item: { path: string }) => item.path === "build/esbuild-native").digest.slice(7)}.bin`), replacement: null },
      { path: join(assets, "unlisted.txt"), replacement: Buffer.from("undeclared") },
    ]) {
      let prior: Buffer | undefined; try { prior = await readFile(mutation.path); } catch { /* deliberately absent extra file */ }
      if (mutation.replacement === null) await rm(mutation.path); else await writeFile(mutation.path, mutation.replacement);
      const result = await child(installed, [join(installed, "check.mjs")]); assert.notEqual(result.code, 0, mutation.path); assert.equal(result.stdout, "");
      if (prior === undefined) await rm(mutation.path); else await writeFile(mutation.path, prior);
    }
    const restored = await child(installed, [join(installed, "check.mjs")]); assert.equal(restored.code, 0, restored.stderr);
  });
});
