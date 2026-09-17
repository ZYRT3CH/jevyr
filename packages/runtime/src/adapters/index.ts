export * from "./command-minds.js";
export * from "./codex-app-server.js";
export * from "./mcp-sampling.js";
export * from "./openai-compatible.js";
export * from "./prompt.js";
export * from "./rule-mind.js";
export * from "./text-stdin.js";
export * from "./claude-agent-sdk.js";

import type { MindAdapter } from "../contracts.js";
import { ClaudeCliMindAdapter, CodexCliMindAdapter } from "./command-minds.js";
import { CodexAppServerMindAdapter, configuredCodexAppServer } from "./codex-app-server.js";
import { lmStudioMind, ollamaMind, OpenAICompatibleMindAdapter } from "./openai-compatible.js";
import { RuleMindAdapter } from "./rule-mind.js";
import { EnvironmentSecretBroker, secretReference } from "../secret-broker.js";
import { configuredTextStdinMind } from "./text-stdin.js";
import { configuredClaudeAgentSdk } from "./claude-agent-sdk.js";

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function investigationTransport(value: string | undefined): "native" | "structured" | undefined {
  if (value === undefined || value === "native" || value === "structured") return value;
  throw new TypeError("Model investigation transport must be native or structured");
}

/**
 * Provider selection is process configuration, never post-seal case input.
 * RuleMind is a no-provider fallback, not a peer that may spend a configured
 * reasoning model's sealed Case budget.
 */
export function configuredMindAdapters(env: NodeJS.ProcessEnv = process.env): MindAdapter[] {
  const minds: MindAdapter[] = [];
  if (env.JEVYR_CLAUDE_TRANSPORT !== undefined && !["cli", "agent-sdk"].includes(env.JEVYR_CLAUDE_TRANSPORT)) throw new TypeError("JEVYR_CLAUDE_TRANSPORT must be cli or agent-sdk");
  if (enabled(env.JEVYR_CODEX_ENABLED)) {
    minds.push(new CodexCliMindAdapter({ ...(env.JEVYR_CODEX_MODEL ? { model: env.JEVYR_CODEX_MODEL } : {}) }));
  }
  if (enabled(env.JEVYR_CODEX_APP_SERVER_ENABLED)) {
    minds.push(configuredCodexAppServer(env));
  }
  if (enabled(env.JEVYR_CLAUDE_ENABLED)) {
    minds.push(env.JEVYR_CLAUDE_TRANSPORT === "agent-sdk" ? configuredClaudeAgentSdk(env) : new ClaudeCliMindAdapter({ ...(env.JEVYR_CLAUDE_MODEL ? { model: env.JEVYR_CLAUDE_MODEL } : {}) }));
  }
  if (env.JEVYR_OLLAMA_MODEL) {
    minds.push(ollamaMind(env.JEVYR_OLLAMA_MODEL, env.JEVYR_OLLAMA_BASE_URL, env.JEVYR_OLLAMA_MODEL_FAMILY, investigationTransport(env.JEVYR_OLLAMA_INVESTIGATION_TRANSPORT)));
  }
  if (env.JEVYR_LMSTUDIO_MODEL) {
    minds.push(lmStudioMind(env.JEVYR_LMSTUDIO_MODEL, env.JEVYR_LMSTUDIO_BASE_URL, env.JEVYR_LMSTUDIO_MODEL_FAMILY, investigationTransport(env.JEVYR_LMSTUDIO_INVESTIGATION_TRANSPORT)));
  }
  if (env.JEVYR_OPENAI_COMPATIBLE_MODEL && env.JEVYR_OPENAI_COMPATIBLE_BASE_URL) {
    const credentialName = env.JEVYR_OPENAI_COMPATIBLE_CREDENTIAL_REF
      ?? (env.JEVYR_OPENAI_COMPATIBLE_API_KEY ? "JEVYR_OPENAI_COMPATIBLE_API_KEY" : undefined);
    const credential = credentialName ? secretReference(credentialName, env.JEVYR_OPENAI_COMPATIBLE_BASE_URL) : undefined;
    minds.push(
      new OpenAICompatibleMindAdapter({
        id: "mind.openai-compatible.configured",
        displayName: "Configured text endpoint",
        baseUrl: env.JEVYR_OPENAI_COMPATIBLE_BASE_URL,
        model: env.JEVYR_OPENAI_COMPATIBLE_MODEL,
        ...(env.JEVYR_OPENAI_COMPATIBLE_MODEL_FAMILY ? { modelFamily: env.JEVYR_OPENAI_COMPATIBLE_MODEL_FAMILY } : {}),
        ...(env.JEVYR_OPENAI_COMPATIBLE_INVESTIGATION_TRANSPORT ? { investigationTransport: investigationTransport(env.JEVYR_OPENAI_COMPATIBLE_INVESTIGATION_TRANSPORT)! } : {}),
        ...(credential ? { credential, secretBroker: new EnvironmentSecretBroker([credential], env) } : {}),
        allowRemote: enabled(env.JEVYR_OPENAI_COMPATIBLE_ALLOW_REMOTE),
      }),
    );
  }
  const stdin = configuredTextStdinMind(env);
  if (stdin) minds.push(stdin);
  return minds.length > 0 ? minds : [new RuleMindAdapter()];
}

export function knownAdapterProbes(env: NodeJS.ProcessEnv = process.env): MindAdapter[] {
  const stdin = configuredTextStdinMind(env);
  return [
    new RuleMindAdapter(),
    new CodexCliMindAdapter({ ...(env.JEVYR_CODEX_MODEL ? { model: env.JEVYR_CODEX_MODEL } : {}) }),
    new CodexAppServerMindAdapter({ ...(env.JEVYR_CODEX_MODEL ? { model: env.JEVYR_CODEX_MODEL } : {}) }),
    new ClaudeCliMindAdapter({ ...(env.JEVYR_CLAUDE_MODEL ? { model: env.JEVYR_CLAUDE_MODEL } : {}) }),
    ollamaMind(env.JEVYR_OLLAMA_MODEL ?? "qwen3-coder:30b", env.JEVYR_OLLAMA_BASE_URL, env.JEVYR_OLLAMA_MODEL_FAMILY, investigationTransport(env.JEVYR_OLLAMA_INVESTIGATION_TRANSPORT)),
    lmStudioMind(env.JEVYR_LMSTUDIO_MODEL ?? "local-model", env.JEVYR_LMSTUDIO_BASE_URL, env.JEVYR_LMSTUDIO_MODEL_FAMILY, investigationTransport(env.JEVYR_LMSTUDIO_INVESTIGATION_TRANSPORT)),
    ...(stdin ? [stdin] : []),
  ];
}
