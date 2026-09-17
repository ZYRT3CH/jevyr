import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { compileIntentContract } from "../packages/core/src/index.js";
import { canonicalize, createSearchEnvelope, digestJson, sha256Digest, type JsonValue } from "../packages/protocol/src/index.js";
import { DEFAULT_SEARCH_PROFILE, OpenAICompatibleMindAdapter, compileAssayFrontier, compileExperimentCapability, investigationImplementationDescriptor, type MindRequest, type SealedCaseContext, type SubjectTextProjection } from "../packages/runtime/src/index.js";

const root = resolve("artifacts", `model-investigation-${Date.now()}`);
await mkdir(root, { recursive: true });
const fixtureSeed = process.argv.find(argument => argument.startsWith("--fixture-seed="))?.slice("--fixture-seed=".length);
const selectedModel = process.argv.slice(2).find(argument => ["mistral", "qwen3-coder"].includes(argument));
const sentinel = fixtureSeed ? sha256Digest(`jevyr.model-tool-fixture:${fixtureSeed}`).slice(7, 31) : randomBytes(12).toString("hex");
const source = `export const sentinel = "${sentinel}";\nexport const triple = (value) => value * 4;\n`;
const impulse = "Inspect the sealed source using your context tools. Construct a finite executable regression probe for triple(3), whose intended result is 9. Include the exact source sentinel in the probe output and reproduce the source expression faithfully. Do not guess the sentinel. Success means `node jevyr.experiment.mjs` exits with code 0.";
const intentContract = compileIntentContract({ impulse });
const identity = investigationImplementationDescriptor();
const hash = (value: unknown) => digestJson(value as JsonValue);
const searchEnvelope = createSearchEnvelope(DEFAULT_SEARCH_PROFILE);
const sealed: SealedCaseContext = { protocol: "jevyr.case/1", caseId: `case_native_tool_${sentinel}`, submissionDigest: hash(impulse), subjectMaterialCaptureDigest: sha256Digest(source), caseDigest: hash({ impulse, source: sha256Digest(source) }), runDigest: hash({ sentinel, identity }), sealedAt: new Date().toISOString(), policyVersion: "investigation-measurement", policyDigest: identity.digest, genomeVersion: "fixture", genomeDigest: hash("explicit local measurement fixture"), searchEnvelope, intentContractDigest: intentContract.digest, intentContract, intent: { impulse, mode: "auto", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control: "sovereign", seed: "native-tool-proof-v1" }, subjects: [] };
const body = { protocol: "jevyr.subject-text-projection/1" as const, files: [{ subjectId: "fixture", path: "math.mjs", sourceDigest: sha256Digest(source), sourceByteLength: Buffer.byteLength(source), text: source }], omissions: [], manifestDigests: [], includedBytes: Buffer.byteLength(source), limits: { maxFileBytes: 96_000, maxTotalBytes: 512_000, maxFiles: 256 } };
const projection: SubjectTextProjection = { ...body, projectionDigest: hash(body) };
const frontier = compileAssayFrontier([{ assayId: "bound.node", costUnits: 1, tool: "forge.command", args: { command: "node", args: ["jevyr.experiment.mjs"] }, obligationId: intentContract.criticalObligations[0]!.id }], DEFAULT_SEARCH_PROFILE.resources);
const request: MindRequest = { stage: "diverge", role: "divergent", sealed, publicFacts: [], constraints: [], seed: hash("tool-proof-seed"), experimentCapability: compileExperimentCapability(frontier, intentContract), subjectProjection: projection, investigationTools: true, maxInputTokens: 200_000, maxOutputTokens: 8_000, signal: AbortSignal.timeout(300_000) };
const outputs: unknown[] = [];
const transportDiagnostics: unknown[] = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const publicToolResults: unknown[] = [];
  try {
    const sent = JSON.parse(String(args[1]?.body)) as any;
    for (const message of sent.messages ?? []) {
      if (message.role !== "tool" && message.role !== "user") continue;
      let value;
      try { value = JSON.parse(message.content); } catch { continue; }
      if (message.role === "tool" || value.protocol === "jevyr.context-tool-result/1") publicToolResults.push(value);
    }
  } catch { /* Diagnostic data never changes transport behavior. */ }
  const response = await nativeFetch(...args);
  if (String(args[0]).includes("chat/completions")) {
    try {
      const value = await response.clone().json() as any;
      const choice = value.choices?.[0];
      transportDiagnostics.push({ status: response.status, model: value.model ?? null, publicToolResults, finishReason: choice?.finish_reason ?? null, publicContentBytes: Buffer.byteLength(choice?.message?.content ?? ""), publicResponse: String(choice?.message?.content ?? "").slice(0, 40_000), toolNames: choice?.message?.tool_calls?.map((call: any) => call.function?.name ?? null) ?? [], usage: value.usage ?? null });
    } catch { transportDiagnostics.push({ status: response.status, decode: "failed" }); }
  }
  return response;
};
for (const [model, modelFamily] of [["qwen3-coder:30b-32k", "qwen3-coder"], ["mistral:7b", "mistral"]]) {
  if (selectedModel && selectedModel !== modelFamily) continue;
  const mind = new OpenAICompatibleMindAdapter({ id: `mind.local.${modelFamily}`, displayName: model!, baseUrl: "http://127.0.0.1:11434/v1/", model: model!, modelFamily: modelFamily!, investigationTransport: modelFamily === "mistral" ? "structured" : "native", timeoutMs: 300_000 });
  const started = performance.now();
  try {
    const result = await mind.runMetered({ ...request, signal: AbortSignal.timeout(300_000) });
    const material = JSON.stringify(result.contributions.map(value => value.candidateBlueprintSource));
    const observedSource = result.investigation?.tools.some(tool => tool.status === "observed" && tool.sourceDigests.includes(sha256Digest(source))) ?? false;
    const foundSentinel = material.includes(sentinel);
    const report = { model, modelFamily, status: observedSource && foundSentinel ? "PASS" : "FAIL", observedSource, foundSentinel, elapsedMillis: Math.round(performance.now() - started), result };
    outputs.push(report);
    process.stdout.write(JSON.stringify({ model, status: report.status, observedSource, foundSentinel, providerRounds: result.investigation?.providerRounds }) + "\n");
  } catch (error) {
    outputs.push({ model, modelFamily, status: "FAIL", elapsedMillis: Math.round(performance.now() - started), error: error instanceof Error ? error.message : "Unknown bounded adapter failure" });
    process.stdout.write(JSON.stringify({ model, status: "FAIL" }) + "\n");
  }
}
const report = { protocol: "jevyr.model-investigation-proof/1", fixtureSeed: fixtureSeed ?? null, scope: "The listed local raw models on one finite sealed-source fixture, direct adapter investigation only. No lifecycle or verdict claim; distinct configured families share one local provider. Earlier failed attempts remain separate retained reports, not a success-rate estimate.", implementation: identity, sealed, projection, outputs, transportDiagnostics };
await writeFile(join(root, "report.json"), canonicalize(report as unknown as JsonValue));
process.stdout.write(JSON.stringify({ report: join(root, "report.json") }) + "\n");
