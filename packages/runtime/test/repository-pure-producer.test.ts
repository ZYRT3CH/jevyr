import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { sealCase } from "@jevyr/core";
import { canonicalize, createSearchEnvelope, digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";
import { analyzeRepositoryPureAssertions, analyzeRepositoryPureAssertionContext, decodeRepositoryPureAssertionContext, deriveRepositoryPureAssertionContext, type RepositoryPureAssertionInput } from "../src/repository-pure-assertions.js";
import { createRepositoryPureProducerAssets, assertRepositoryPureProducerAssets, prepareRepositoryPureProducerPackage, materializeRepositoryPureProducerPackage, type RepositoryPureProducerAssets, type RepositoryPureProducerPackage } from "../src/repository-pure-producer.js";
import { decodeRepositoryPureProducerImplementation, decodeRepositoryPureProducerRequest, pureProducerBytes, pureProducerPath, reconstructRepositoryPureProducerResult } from "../src/repository-pure-producer-data.js";

const hash = (value: unknown) => digestJson(value as JsonValue), assetsPromise = createRepositoryPureProducerAssets();
function fixture(source = "export const add=(a,b)=>a+b;", testSource = 'import test from "node:test"; import assert from "node:assert/strict"; import {add} from "../src/add.mjs"; test("sum",()=>assert.equal(add(2,3),5));') {
  const blobs = new Map<string, Buffer>(), locator = "C:/PRIVATE-HOST-LOCATOR/never-access-this-repository";
  const entries = Object.entries({ "src/add.mjs": source, "tests/add.test.mjs": testSource }).map(([path, text]) => {
    const bytes = Buffer.from(text), blobDigest = sha256Digest(bytes); blobs.set(blobDigest, bytes); return { path, blobDigest, byteLength: bytes.length, mode: 0o644 };
  });
  const manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId: "repo", subjectKind: "directory", subjectDigest: hash(entries), availability: "MATERIALIZED", entries, directories: ["src", "tests"], omissions: [], byteLength: entries.reduce((sum, file) => sum + file.byteLength, 0) };
  const binding: SubjectMaterialBinding = { subjectId: "repo", subjectKind: "directory", subjectDigest: manifest.subjectDigest, availability: "MATERIALIZED", byteLength: manifest.byteLength, manifestDigest: hash(manifest) }, bindings = [binding];
  const sealedCase = sealCase({ protocol: "jevyr.case/1", case: { impulse: "Existing tests must pass.", subjects: [{ id: "repo", kind: "directory", locator }], privacy: "local_only", control: "sovereign", seed: "producer-held-fixture" } }, {
    policyVersion: "jevyr.bone/1", genomeVersion: "jevyr.genome/1", policyDigest: sha256Digest("no authority fixture policy"), genomeDigest: sha256Digest("fixture genome"), searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), sealedAt: "2026-09-05T12:00:00.000Z",
    subjectMaterialCaptureDigest: hash({ protocol: "jevyr.subject-material-capture/1", bindings }), subjectSnapshots: [{ subjectId: "repo", digest: manifest.subjectDigest, resolvedLocator: locator, byteLength: manifest.byteLength, capturedAt: "2026-09-05T12:00:00.000Z" }],
  });
  const input: RepositoryPureAssertionInput = { sealedCase, bindings, reader: { readManifest: async () => manifest, readBlob: async digest => Buffer.from(blobs.get(digest) ?? []) },
    runner: { id: "node-test-v1", evaluatorDigest: sha256Digest("fixture discovery"), immutableImageId: sha256Digest("fixture image"), capabilityId: "forge.oci" }, limits: { maxCertificateBytes: 500_000 } };
  return { input, locator, blobs, manifest };
}
async function temporary<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-pure-package-"));
  try { return await work(root); } finally {
    const expected = resolve(tmpdir()) + sep; assert.ok(resolve(root).startsWith(expected)); assert.ok(root.includes("jevyr-pure-package-"));
    const writable = async (path: string): Promise<void> => { const info = await lstat(path); if(info.isSymbolicLink()) return; await chmod(path, info.isDirectory() ? 0o700 : 0o600); if (info.isDirectory()) for (const item of await readdir(path)) await writable(join(path, item)); };
    await writable(root); await rm(root, { recursive: true, force: true });
  }
}
async function run(root: string): Promise<{ exitCode: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(root, "repository-pure", "producer.mjs")], { cwd: root, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: "" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let total = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error("trusted producer timeout")); }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => { total += chunk.length; if (total > 1_000_000) { child.kill(); reject(Error("producer output cap")); } else stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.reduce((n, item) => n + item.length, 0) < 8192) stderr.push(chunk); });
    child.on("error", error => { clearTimeout(timer); reject(error); }); child.on("close", exitCode => { clearTimeout(timer); done({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

test("prepared context omits host locators, shares exact analysis, and is never an authenticated Seal", async () => {
  const f = fixture(), context = deriveRepositoryPureAssertionContext(f.input.sealedCase), { sealedCase: _, ...rest } = f.input;
  assert.ok(!JSON.stringify(context).includes(f.locator)); assert.ok(!("intent" in context) && !("subjects" in context));
  assert.equal(context.caseDigest, f.input.sealedCase.caseDigest); assert.equal(context.runDigest, f.input.sealedCase.runDigest);
  assert.deepEqual(await analyzeRepositoryPureAssertionContext({ ...rest, context }), await analyzeRepositoryPureAssertions(f.input));
  const forged = { ...context, caseDigest: sha256Digest("foreign identity") }; const { digest: __, ...body } = forged;
  // A structurally consistent prepared context has no signature authority; it may
  // analyze data, but cannot substitute for the host API's actual Case input.
  const changed = decodeRepositoryPureAssertionContext({ ...body, digest: hash(body) }); assert.notEqual(changed.digest, context.digest);
  assert.equal((await analyzeRepositoryPureAssertionContext({ ...rest, context: changed })).authority, "none");
  assert.equal((await analyzeRepositoryPureAssertions({ ...f.input, sealedCase: changed } as unknown as RepositoryPureAssertionInput)).status, "unavailable");
  for (const candidate of [{ ...context, locator: f.locator }, { ...context, subject: { ...context.subject, resolvedLocator: f.locator } }, { ...context, intentContract: { ...context.intentContract, originalImpulse: "Review everything." } }]) assert.throws(() => decodeRepositoryPureAssertionContext(candidate));
});

test("trusted bundle is deterministic and pins all parser, grammar, transform and compiler dependencies", async () => {
  const assets = await assetsPromise, again = await createRepositoryPureProducerAssets();
  assert.deepEqual(assets.descriptor, again.descriptor); assert.deepEqual(assets.files(), again.files());
  for (const path of ["runtime/repository-pure-producer.ts", "runtime/repository-pure-producer-runner.ts", "runtime/repository-pure-producer-data.ts", "runtime/repository-pure-assertions.ts", "runtime/repository-evaluation-plan.ts", "runtime/repository-evaluation-closure.ts", "npm/web-tree-sitter/tree-sitter.js", "npm/web-tree-sitter/tree-sitter.wasm", "npm/tree-sitter-wasms/tree-sitter-javascript.wasm", "virtual/core-facade.js", "build/esbuild-api.js", "build/esbuild-native"]) assert.ok(assets.descriptor.inputs.some(item => item.path === path), path);
  assert.equal(assets.descriptor.transforms.length, 2); assert.deepEqual(assets.descriptor.assets.map(file => file.path), ["producer.mjs", "tree-sitter-javascript.wasm", "tree-sitter.wasm"]);
  assert.ok(!JSON.stringify(assets.descriptor).includes(process.cwd())); assert.equal(decodeRepositoryPureProducerImplementation(pureProducerBytes(assets.descriptor)).digest, assets.descriptor.digest);
  const detached = assets.files(); detached[0]!.bytes.fill(0); assert.notEqual(sha256Digest(detached[0]!.bytes), assets.descriptor.assets[0]!.digest); assert.equal(sha256Digest(assets.files()[0]!.bytes), assets.descriptor.assets[0]!.digest);
  assert.ok(Object.isFrozen(assets.descriptor.assets[0])); assert.throws(() => assertRepositoryPureProducerAssets({ ...assets }));
});

test("request construction privately brands complete detached bytes, rejects forged packages and mutated CAS", async () => {
  const assets = await assetsPromise, f = fixture(), prepared = await prepareRepositoryPureProducerPackage(f.input, assets);
  assert.equal(prepared.expectedResult.analysis.outcome, "match"); assert.equal(prepared.expectedResult.analysis.authority, "none");
  assert.ok(!Buffer.from(prepared.requestBytes).includes(Buffer.from(f.locator))); assert.equal(prepared.request.context.captureDigest, f.input.sealedCase.subjectMaterialCaptureDigest);
  assert.equal(prepared.files().reduce((sum, file) => sum + file.bytes.length, 0), prepared.descriptor.byteLength);
  assert.equal(prepared.descriptor.maximumFileBytes, Math.max(...prepared.files().map(file => file.bytes.length)));
  assert.equal(prepared.descriptor.fileCount, prepared.files().length);
  const requestBytes = prepared.requestBytes; requestBytes.fill(0); assert.ok(!Buffer.from(prepared.requestBytes).equals(Buffer.from(requestBytes)));
  const detached = prepared.files(); detached[0]!.bytes.fill(0); assert.ok(!Buffer.from(prepared.files()[0]!.bytes).equals(Buffer.from(detached[0]!.bytes)));
  await assert.rejects(prepareRepositoryPureProducerPackage(f.input, { ...assets } as RepositoryPureProducerAssets));
  await temporary(async root => { await assert.rejects(materializeRepositoryPureProducerPackage({ ...prepared } as RepositoryPureProducerPackage, join(root, "forged"))); });
  f.blobs.set(f.manifest.entries[0]!.blobDigest, Buffer.from("altered CAS source")); await assert.rejects(prepareRepositoryPureProducerPackage(f.input, assets));
});

test("closed codecs refuse unbounded, noncanonical, path-changing, mixed-build and foreign-capture requests", async () => {
  const assets = await assetsPromise, prepared = await prepareRepositoryPureProducerPackage(fixture().input, assets);
  for (const path of ["../escape", "/absolute", "a/../b", "a//b", "a\\b", "a/CON.txt", "a/end.", "a/%66.mjs"]) assert.equal(pureProducerPath(path), false, path);
  for (const edit of [(r: any) => { r.extra = true; }, (r: any) => { r.blobs[0].path = "../outside"; }, (r: any) => { r.blobs[0].byteLength = 262145; }, (r: any) => { r.context.captureDigest = sha256Digest("foreign"); }, (r: any) => { r.bindings[0].subjectId = "foreign"; }, (r: any) => { r.limits.maxSteps = 50_001; }]) {
    const request = structuredClone(prepared.request); edit(request); assert.throws(() => decodeRepositoryPureProducerRequest(pureProducerBytes(request), assets.descriptor));
  }
  assert.throws(() => decodeRepositoryPureProducerRequest(Buffer.concat([prepared.requestBytes, Buffer.from("\n")]), assets.descriptor));
  const asCompiled = structuredClone(assets.descriptor) as any;
  for (const entry of asCompiled.inputs) if (entry.path.startsWith("runtime/") && entry.path.endsWith(".ts")) entry.path = entry.path.slice(0, -3) + ".js";
  for (const entry of asCompiled.transforms) entry.path = entry.path.slice(0, -3) + ".js";
  asCompiled.inputs.sort((a: any,b: any)=>a.path<b.path?-1:1); const { digest: _, ...compiledBody } = asCompiled; asCompiled.digest = hash(compiledBody);
  assert.equal(decodeRepositoryPureProducerImplementation(pureProducerBytes(asCompiled)).digest, asCompiled.digest, "coherent compiled-source descriptors remain structurally supported; this does not brand arbitrary assets");
  asCompiled.transforms[0].path = asCompiled.transforms[0].path.slice(0,-3)+".ts"; const { digest: __, ...mixed } = asCompiled; asCompiled.digest=hash(mixed); assert.throws(()=>decodeRepositoryPureProducerImplementation(pureProducerBytes(asCompiled)));
});

test("materializer refuses relative roots and linked ancestors before creating package files", async () => {
  const prepared=await prepareRepositoryPureProducerPackage(fixture().input,await assetsPromise);
  await assert.rejects(materializeRepositoryPureProducerPackage(prepared,"relative-root"));
  await temporary(async root=>{
    const actual=join(root,"actual"), alias=join(root,"alias");await mkdir(actual);await symlink(actual,alias,process.platform==="win32"?"junction":"dir");
    await assert.rejects(materializeRepositoryPureProducerPackage(prepared,join(alias,"subject")));assert.deepEqual(await readdir(actual),[]);
  });
});

test("privately staged trusted JavaScript modules build a coherent installed-mode bundle without touching dist", {timeout:60_000}, async()=>{
  await temporary(async root=>{
    const stage=join(root,"runtime");await mkdir(stage);await writeFile(join(stage,"package.json"),'{"type":"module"}');
    await symlink(fileURLToPath(new URL("../node_modules",import.meta.url)),join(stage,"node_modules"),process.platform==="win32"?"junction":"dir");
    for(const name of ["repository-pure-producer","repository-pure-assets-pin","repository-pure-producer-data","repository-pure-producer-runner","repository-pure-assertions","repository-evaluation-plan","repository-evaluation-closure"]){
      const source=await readFile(new URL(`../src/${name}.ts`,import.meta.url),"utf8");
      const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});await writeFile(join(stage,`${name}.js`),compiled.outputText);
    }
    const script='import {createRepositoryPureProducerAssets} from "./repository-pure-producer.js"; const assets=await createRepositoryPureProducerAssets();process.stdout.write(JSON.stringify(assets.descriptor));';
    await writeFile(join(stage,"probe.mjs"),script);
    const result=await new Promise<{code:number|null;out:string;err:string}>((done,reject)=>{
      const child=spawn(process.execPath,[join(stage,"probe.mjs")],{cwd:stage,env:{SystemRoot:process.env.SystemRoot??"",PATH:""},stdio:["ignore","pipe","pipe"],windowsHide:true});let out="",err="";
      const timer=setTimeout(()=>{child.kill();reject(Error("staged trusted build timeout"));},30_000);child.stdout.on("data",chunk=>{out+=chunk;});child.stderr.on("data",chunk=>{err+=chunk;});child.on("error",reject);child.on("close",code=>{clearTimeout(timer);done({code,out,err});});
    });
    assert.equal(result.code,0,result.err);const descriptor=decodeRepositoryPureProducerImplementation(Buffer.from(result.out));
    assert.ok(descriptor.transforms.every(item=>item.path.endsWith(".js")));assert.ok(descriptor.inputs.some(item=>item.path==="runtime/repository-pure-producer.js"));
    assert.notEqual(descriptor.digest,(await assetsPromise).descriptor.digest,"source and separately compiled implementation identities are distinct");
  });
});

test("standalone trusted producer reconstructs match, mismatch and unavailable data without importing submitted JavaScript", { timeout: 60_000 }, async () => {
  const assets = await assetsPromise;
  for (const [source, expected] of [["export const add=(a,b)=>a+b;", "match"], ["export const add=(a,b)=>a-b;", "mismatch"], ['process.stdout.write("SUBJECT EXECUTED"); export const add=(a,b)=>a+b;', "unavailable"]] as const) {
    const prepared = await prepareRepositoryPureProducerPackage(fixture(source).input, assets);
    await temporary(async root => {
      const subject = join(root, "subject"), descriptor = await materializeRepositoryPureProducerPackage(prepared, subject);
      assert.deepEqual(descriptor, prepared.descriptor); await assert.rejects(materializeRepositoryPureProducerPackage(prepared, subject));
      for (const file of prepared.files()) { const info = await lstat(join(subject, ...file.path.split("/"))); assert.equal(info.nlink,1); assert.equal(info.mode & 0o222,0); assert.equal(sha256Digest(await readFile(join(subject,...file.path.split("/")))),sha256Digest(file.bytes)); }
      const executed = await run(subject); assert.equal(executed.exitCode, 0, executed.stderr); assert.equal(executed.stderr, "");
      assert.deepEqual(executed.stdout, Buffer.concat([pureProducerBytes(prepared.expectedResult), Buffer.from("\n")]));
      assert.equal(JSON.parse(executed.stdout.toString("utf8")).analysis.outcome, expected); assert.ok(!executed.stdout.includes(Buffer.from("SUBJECT EXECUTED")));
    });
  }
});

test("complete readonly package refuses changed assets, undeclared files and changed captured bytes", { timeout: 60_000 }, async () => {
  const prepared = await prepareRepositoryPureProducerPackage(fixture().input, await assetsPromise);
  for (const kind of ["blob", "grammar", "extra", "request"] as const) await temporary(async root => {
    const subject = join(root,"subject"); await materializeRepositoryPureProducerPackage(prepared, subject);
    const path = kind === "blob" ? join(subject,"repository-pure",...prepared.request.blobs[0]!.path.split("/")) : kind === "grammar" ? join(subject,"repository-pure","tree-sitter-javascript.wasm") : kind === "request" ? join(subject,"repository-pure","request.json") : join(subject,"injected.txt");
    if(kind === "extra") await chmod(subject,0o700); else await chmod(path,0o600);
    await writeFile(path,kind === "extra" ? "extra" : "altered"); await chmod(path,0o444);
    const executed = await run(subject); assert.equal(executed.exitCode,2); assert.equal(executed.stdout.length,0); assert.equal(executed.stderr,"Pure producer refused invalid or unavailable package\n");
  });
  const checked = await reconstructRepositoryPureProducerResult(prepared.request, async () => Buffer.from("wrong source"));
  assert.equal(checked.analysis.status,"unavailable"); assert.equal(checked.analysis.authority,"none");
});

test("independent Node24 default discovery includes all native pattern families and excludes spec/plural-directory controls", { timeout: 60_000 }, async () => {
  // These are trusted generated runner probes, not submitted source execution.
  const selected = ["pass.test.mjs", "test.mjs", "nested/sum-test.mjs", "nested/sum_test.mjs", "test-prefix.mjs", "test-.mjs", "_test.mjs", "test/plain.mjs", "nested/test/deeper/plain.mjs", "typed.test.ts", "typed-test.cts", "typed_test.mts"];
  const omitted = ["ignored.spec.mjs", "tests/not-native.mjs", "regular.mjs", "test.jsx", "test.tsx", ".test.mjs", ".hidden/test.mjs", "node_modules/failing.test.mjs", "nested/node_modules/failing.test.mjs", "test/.hidden.mjs"];
  await temporary(async root => {
    for (const [index,path] of [...selected,...omitted].entries()) {
      const absolute = join(root,...path.split("/")); await mkdir(dirname(absolute),{recursive:true});
      const test = path.endsWith(".cts") ? 'const test=require("node:test");' : 'import test from "node:test";';
      await writeFile(absolute, `${test} test("native-probe-${index}",()=>{${index === 1 ? 'throw Error("deliberate hidden native failure");' : ""}});`);
    }
    const result = await new Promise<{code:number|null;out:string}>((done,reject)=>{
      const child=spawn(process.execPath,["--test","--test-reporter=tap","--test-concurrency=1"],{cwd:root,env:{SystemRoot:process.env.SystemRoot??"",PATH:""},stdio:["ignore","pipe","pipe"],windowsHide:true});
      let out="",err="";const timer=setTimeout(()=>{child.kill();reject(Error("native discovery timeout"));},30_000);
      child.stdout.on("data",chunk=>{out+=chunk; if(out.length>100_000){child.kill();reject(Error("native output bound"));}});child.stderr.on("data",chunk=>{err+=chunk;});
      child.on("error",reject);child.on("close",code=>{clearTimeout(timer);assert.equal(err,"");done({code,out});});
    });
    assert.equal(result.code,1,"the native test.mjs must fail despite an ordinary passing *.test.mjs");
    for(let i=0;i<selected.length;i++)assert.match(result.out,new RegExp(`(?:ok|not ok) \\d+ - native-probe-${i}\\n`),selected[i]);
    for(let i=selected.length;i<selected.length+omitted.length;i++)assert.ok(!result.out.includes(`native-probe-${i}`),omitted[i-selected.length]);
  });
});
