import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredMindAdapters, knownAdapterProbes } from "../src/index.js";

test("model family is explicit sealed configuration and is never inferred from a model name", () => {
  const explicit = configuredMindAdapters({ JEVYR_OLLAMA_MODEL: "arbitrary-alias", JEVYR_OLLAMA_MODEL_FAMILY: "configured-qwen-family" })[0]!;
  const unknown = configuredMindAdapters({ JEVYR_OLLAMA_MODEL: "qwen3-model-name" })[0]!;
  assert.equal(explicit.capability.limits?.modelFamily, "configured-qwen-family");
  assert.equal(explicit.capability.limits?.adapterClass, "model");
  assert.equal(unknown.capability.limits?.modelFamily, undefined);
  assert.match(String(explicit.capability.limits?.investigationImplementationDigest), /^sha256:[a-f0-9]{64}$/u);
});

test("structured model transport is explicit startup configuration and invalid values fail closed", () => {
  const mind = configuredMindAdapters({ JEVYR_OLLAMA_MODEL: "mistral:7b", JEVYR_OLLAMA_INVESTIGATION_TRANSPORT: "structured" })[0]!;
  assert.equal(mind.capability.limits?.investigationTransport, "structured");
  assert.throws(() => configuredMindAdapters({ JEVYR_OLLAMA_MODEL: "mistral:7b", JEVYR_OLLAMA_INVESTIGATION_TRANSPORT: "run-shell" }), /native or structured/u);
});

test("RuleMind is the sole fallback when no reasoning Mind is configured", () => {
  const minds = configuredMindAdapters({});
  assert.deepEqual(minds.map((mind) => mind.capability.id), ["mind.rule.v1"]);
});

test("a configured local reasoning Mind replaces rather than supplements RuleMind", () => {
  const minds = configuredMindAdapters({
    JEVYR_OLLAMA_MODEL: "qwen3-coder:30b-32k",
    JEVYR_OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1/",
  });
  assert.deepEqual(minds.map((mind) => mind.capability.id), ["mind.ollama.qwen3-coder:30b-32k"]);
  assert.ok(minds.every((mind) => mind.capability.id !== "mind.rule.v1"));
});

test("every explicitly configured reasoning Mind participates without a template budget consumer", () => {
  const minds = configuredMindAdapters({
    JEVYR_CODEX_ENABLED: "true",
    JEVYR_CODEX_APP_SERVER_ENABLED: "1",
    JEVYR_CLAUDE_ENABLED: "true",
    JEVYR_OLLAMA_MODEL: "ollama-model",
    JEVYR_LMSTUDIO_MODEL: "lmstudio-model",
    JEVYR_OPENAI_COMPATIBLE_MODEL: "compatible-model",
    JEVYR_OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:8080/v1/",
  });
  assert.deepEqual(minds.map((mind) => mind.capability.id), [
    "mind.codex-cli.v1",
    "mind.codex-app-server.v1",
    "mind.claude-cli.v1",
    "mind.ollama.ollama-model",
    "mind.lmstudio.lmstudio-model",
    "mind.openai-compatible.configured",
  ]);
  assert.ok(minds.every((mind) => mind.capability.id !== "mind.rule.v1"));
});

test("known adapter probes retain RuleMind as an explicit diagnostic template", () => {
  const probes = knownAdapterProbes({ JEVYR_OLLAMA_MODEL: "configured-model" });
  assert.equal(probes[0]?.capability.id, "mind.rule.v1");
  assert.ok(probes.some((mind) => mind.capability.id === "mind.ollama.configured-model"));
});
