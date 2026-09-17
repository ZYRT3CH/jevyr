import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CodexAppServerMindAdapter } from "../packages/runtime/src/adapters/codex-app-server.js";
import { ClaudeAgentSdkMindAdapter } from "../packages/runtime/src/adapters/claude-agent-sdk.js";
import { ClaudeCliMindAdapter } from "../packages/runtime/src/adapters/command-minds.js";
import { providerLauncher } from "../packages/runtime/src/adapters/provider-launcher.js";
import { quarantinedProviderEnvironment, withQuarantinedMindWorkspace } from "../packages/runtime/src/adapters/process-quarantine.js";
import { runBoundedProcess } from "../packages/runtime/src/process.js";
import { digestJson, type JsonValue } from "../packages/protocol/src/index.js";

const names = ["JEVYR_CODEX_ENABLED", "JEVYR_CODEX_APP_SERVER_ENABLED", "JEVYR_CODEX_MODEL", "JEVYR_CODEX_API_KEY_REF", "JEVYR_CLAUDE_ENABLED", "JEVYR_CLAUDE_TRANSPORT", "JEVYR_CLAUDE_MODEL", "JEVYR_CLAUDE_SDK_API_KEY_REF"];
const configured = Object.fromEntries(names.map(name => {
  const raw = process.env[name], referenceValid = typeof raw === "string" && /^env:[A-Z][A-Z0-9_]{0,127}$/u.test(raw);
  return [name, { present: !!raw?.trim(), ...(name.endsWith("_REF") ? { referenceValid, referencedValuePresent: referenceValid && !!process.env[raw!.slice(4)]?.trim() } : {}) }];
}));
const launchers = Object.fromEntries(["codex", "claude"].map(provider => [provider, providerLauncher(provider as "codex" | "claude", {})]));
async function status(provider: "codex" | "claude") {
  const launcher = launchers[provider]!;
  return await withQuarantinedMindWorkspace(async cwd => {
    const invoke = async (args: string[]) => await runBoundedProcess({ command: launcher.command, args: [...launcher.args, ...args], cwd,
      env: quarantinedProviderEnvironment(cwd), inheritEnv: false, timeoutMs: 10_000, maxOutputBytes: 32_768 });
    try {
      const help = await invoke(provider === "codex" ? ["login", "--help"] : ["--safe-mode", "auth", "--help"]);
      if (help.exitCode !== 0 || !/\bstatus\b/u.test(help.stdout + help.stderr)) return { statusCommandSupported: false, loggedIn: null, reason: "Installed help did not declare an authentication status command" };
      const response = await invoke(provider === "codex" ? ["login", "status"] : ["--safe-mode", "auth", "status", "--json"]);
      // Never publish or retain the raw authentication command output, account IDs, or key prefixes.
      if (provider === "codex") {
        const text = response.stdout + response.stderr;
        const kind = /Logged in using ChatGPT/iu.test(text) ? "chatgpt" : /Logged in using an API key/iu.test(text) ? "api-key" : /not logged in/iu.test(text) ? "none" : "unrecognized";
        return { statusCommandSupported: true, exitCode: response.exitCode, timedOut: response.timedOut, loggedIn: kind === "chatgpt" || kind === "api-key" ? true : kind === "none" ? false : null, authenticationKind: kind };
      }
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(response.stdout) as Record<string, unknown>; } catch { return { statusCommandSupported: true, exitCode: response.exitCode, timedOut: response.timedOut, loggedIn: null, authenticationKind: "unrecognized" }; }
      const authenticationKind = typeof raw.authMethod === "string" && ["claude.ai", "api_key", "apiKey", "none", "oauth"].includes(raw.authMethod) ? raw.authMethod : "unrecognized";
      return { statusCommandSupported: true, exitCode: response.exitCode, timedOut: response.timedOut, loggedIn: typeof raw.loggedIn === "boolean" ? raw.loggedIn : null, authenticationKind };
    } catch { return { statusCommandSupported: false, loggedIn: null, reason: "Bounded installed authentication status command unavailable" }; }
  });
}
const probes = [];
for (const adapter of [new CodexAppServerMindAdapter(), new ClaudeCliMindAdapter(), new ClaudeAgentSdkMindAdapter({ model: "readiness-probe-only-no-inference" })]) probes.push({ id: adapter.capability.id, ...await adapter.probe() });
const authentication = { codex: await status("codex"), claude: await status("claude") };
const body = { protocol: "jevyr.agent-harness-readiness/1", observedAt: new Date().toISOString(), configured, launchers, probes, authentication,
  scope: "Read-only installed harness initialization and sanitized existing account status. No model prompt, inference, login, credential copying, installation, or daemon configuration change. Ambient account status is separate from Judge's explicit credential-broker readiness." };
const report = { ...body, digest: digestJson(body as unknown as JsonValue) };
const root = resolve(import.meta.dirname, "..", "artifacts", `agent-harness-readiness-${Date.now()}`); await mkdir(root);
await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ root, ...report }));
