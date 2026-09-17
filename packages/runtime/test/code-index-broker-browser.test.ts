import assert from "node:assert/strict";
import { test } from "node:test";
import { digestJson, sha256Digest } from "@jevyr/protocol";
import { indexSealedCode, codeImpact, EnvironmentSecretBroker, secretReference, OpenAICompatibleMindAdapter, browserProbeAssay, validateBrowserProbeSpec, type SubjectTextProjection } from "../src/index.js";

test("Tree-sitter links sealed symbol locations and reverse dependency closure, rejecting changed bytes", async () => {
  const files = [
    { path: "a.ts", text: "import {b} from './b.js'; export function a() {return b();}" },
    { path: "b.ts", text: "export function b() {return 4;}" },
  ].map(file => ({ ...file, subjectId: "subject", sourceDigest: sha256Digest(file.text), sourceByteLength: Buffer.byteLength(file.text) }));
  const body = { protocol: "jevyr.subject-text-projection/1" as const, files, omissions: [], manifestDigests: [], includedBytes: files.reduce((sum, file) => sum + file.sourceByteLength, 0), limits: { maxFileBytes: 1000, maxFiles: 2, maxTotalBytes: 2000 } };
  const projection: SubjectTextProjection = { ...body, projectionDigest: digestJson(body) };
  const index = await indexSealedCode(projection);
  assert.equal(index.nodes.find(node => node.name === "a")?.startLine, 1);
  assert.equal(index.dependencies[0]?.resolvedPath, "b.ts");
  assert.deepEqual(codeImpact(index, "subject", ["b.ts"]), ["a.ts", "b.ts"]);
  assert.equal((await indexSealedCode(projection)).digest, index.digest);
  await assert.rejects(indexSealedCode({ ...projection, files: [{ ...files[0]!, text: "different" }] }), /mismatched projection/);
  const changed = { ...body, files: [{ ...files[0]!, text: "different" }] };
  await assert.rejects(indexSealedCode({ ...changed, projectionDigest: digestJson(changed) }), /mismatched source/);
  const bounded = await indexSealedCode(projection, 1);
  assert.equal(bounded.nodes.length, 1);
  assert.ok(bounded.omissions.some(entry => entry.reason === "node-budget"));
});

test("broker audience isolation and serializable adapter state exclude credential values", () => {
  const reference = secretReference("LOCAL_TEST_KEY", "https://provider.example/v1/");
  const environment = { LOCAL_TEST_KEY: "fixture-secret-value" };
  const broker = new EnvironmentSecretBroker([reference], environment);
  environment.LOCAL_TEST_KEY = "changed-after-startup";
  assert.equal(broker.authorization(reference, "https://provider.example/v1/chat/completions"), "Bearer fixture-secret-value");
  assert.throws(() => broker.authorization(reference, "https://unrelated.example/v1"), /not authorized/);
  assert.throws(() => new EnvironmentSecretBroker([reference], { LOCAL_TEST_KEY: "value\r\nheader" }), /unavailable/);
  const adapter = new OpenAICompatibleMindAdapter({ id: "secret-test", displayName: "Broker test", baseUrl: "https://provider.example/v1/", allowRemote: true, model: "fixture", credential: reference, secretBroker: broker });
  assert.equal(JSON.stringify(adapter).includes("fixture-secret-value"), false);
  assert.equal(JSON.stringify(broker), "{}");
  const legacy = new OpenAICompatibleMindAdapter({ id: "legacy", displayName: "Legacy", baseUrl: "http://localhost/v1", model: "fixture", apiKey: "legacy-secret" });
  assert.equal(JSON.stringify(legacy).includes("legacy-secret"), false);
});

test("browser specification is sealed finite data, with no evaluator scripting or vacuous pass", () => {
  const spec = { protocol: "jevyr.browser-probe/1" as const, entry: "index.html", steps: [{ action: "assert-text" as const, selector: "h1", expected: "Hello" }] };
  const plan = browserProbeAssay(spec);
  assert.equal(plan.args.command, "node");
  assert.equal((plan.args.args as string[])[0], "/opt/jevyr/browser-probe.mjs");
  assert.throws(() => validateBrowserProbeSpec({ ...spec, evaluate: "process.exit(0)" }), /Invalid/);
  assert.throws(() => validateBrowserProbeSpec({ ...spec, entry: "../secret.html" }), /Invalid/);
  assert.throws(() => validateBrowserProbeSpec({ ...spec, steps: [{ action: "click", selector: "button" }] }), /assertion/);
  assert.throws(() => validateBrowserProbeSpec({ ...spec, steps: [{ action: "assert-count", selector: "p", expected: -1 }] }), /count/);
});
