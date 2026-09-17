import { parseJsonText } from "@jevyr/core";
import type { AgentAdapter, CapabilityCard, MindAdapter, MindInvocationResult, MindRequest, ProbeResult, PublicContribution } from "../contracts.js";
import { MAX_MIND_RAW_OUTPUT_BYTES, MindMeteredFailure, providerOrConservativeUsage } from "../mind-metering.js";
import { runBoundedProcess } from "../process.js";
import { makePublicMindPrompt, parsePublicContributions } from "./prompt.js";
import { providerLauncher } from "./provider-launcher.js";
import {
  quarantinedProviderEnvironment,
  rejectCallerWorkingDirectory,
  withQuarantinedMindWorkspace,
} from "./process-quarantine.js";

export interface CommandMindOptions {
  readonly command?: string;
  /** Prefix arguments for a command launcher. Primarily useful for hermetic provider wrappers. */
  readonly launcherArgs?: readonly string[];
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

abstract class CommandMindAdapter implements MindAdapter {
  abstract readonly capability: CapabilityCard;
  protected abstract readonly defaultCommand: string;
  protected readonly options: CommandMindOptions;

  constructor(options: CommandMindOptions = {}) {
    rejectCallerWorkingDirectory(options, "Process-backed mind adapter");
    if (
      options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > MAX_MIND_RAW_OUTPUT_BYTES)
    ) {
      throw new RangeError(`maxOutputBytes must be an integer from 1 through ${MAX_MIND_RAW_OUTPUT_BYTES}`);
    }
    this.options = options;
  }

  protected get command(): string {
    return this.options.command ?? this.defaultCommand;
  }

  protected abstract args(): string[];
  protected abstract finalText(stdout: string): string;
  protected providerUsage(_stdout: string): { readonly inputTokens?: unknown; readonly outputTokens?: unknown } {
    return {};
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    const launcher = providerLauncher(this.defaultCommand as "codex"|"claude",this.options);
    try {
      const result = await withQuarantinedMindWorkspace(
        async (cwd) =>
          await runBoundedProcess({
            command: launcher.command,
            args: [...launcher.args, "--version"],
            cwd,
            env: quarantinedProviderEnvironment(cwd),
            inheritEnv: false,
            timeoutMs: 5_000,
            maxOutputBytes: 16_000,
            ...(signal ? { signal } : {}),
          }),
      );
      const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0]?.slice(0, 200);
      return {
        available: result.exitCode === 0,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        ...(version ? { version } : {}),
        detail: result.exitCode === 0 ? `${this.command} is executable.` : `${this.command} exited ${result.exitCode}.`,
      };
    } catch (error) {
      return {
        available: false,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async runMetered(request: MindRequest): Promise<MindInvocationResult> {
    const prompt = makePublicMindPrompt(request);
    const launcher = providerLauncher(this.defaultCommand as "codex"|"claude",this.options);
    const result = await withQuarantinedMindWorkspace(
      async (cwd) =>
        await runBoundedProcess({
          command: launcher.command,
          args: [...launcher.args, ...this.args()],
          cwd,
          env: quarantinedProviderEnvironment(cwd),
          inheritEnv: false,
          stdin: prompt,
          timeoutMs: this.options.timeoutMs ?? 180_000,
          maxOutputBytes: this.options.maxOutputBytes ?? MAX_MIND_RAW_OUTPUT_BYTES,
          signal: request.signal,
        }),
    );
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        `${this.capability.displayName} ${result.timedOut ? "timed out" : `exited ${result.exitCode}`}: ${result.stderr.slice(0, 1_000)}`,
      );
    }
    const finalText = this.finalText(result.stdout);
    const contributions = parsePublicContributions(finalText, this.capability.id, request);
    const reported = this.providerUsage(result.stdout);
    return Object.freeze({
      contributions: Object.freeze(contributions),
      ...providerOrConservativeUsage(
        prompt,
        result.stdout,
        reported.inputTokens,
        reported.outputTokens,
      ),
    });
  }

  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    const result = await this.runMetered(request);
    for (const item of result.contributions) yield item;
  }
}

export class CodexCliMindAdapter extends CommandMindAdapter implements AgentAdapter {
  readonly adapterClass = "agent" as const;
  readonly capability: CapabilityCard = {
    id: "mind.codex-cli.v1",
    kind: "mind",
    displayName: "Codex CLI",
    version: "1",
    transport: "process",
    trust: "quarantined",
    modalities: ["text", "structured-data"],
    network: "provider",
    canExecuteTools: false,
    deterministic: false,
  };
  protected readonly defaultCommand = "codex";

  override async probe(signal?:AbortSignal):Promise<ProbeResult> {
    const executable=await super.probe(signal);
    return {...executable,available:false,detail:"Legacy Codex CLI inference is closed: select the explicit app-server transport for an enforceable sealed-context boundary."};
  }
  override async runMetered(_request:MindRequest):Promise<MindInvocationResult> {
    throw new MindMeteredFailure("Legacy Codex CLI inference is closed; configure the isolated app-server transport",0);
  }

  protected args(): string[] {
    return [
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      ...(this.options.model ? ["--model", this.options.model] : []),
      "-",
    ];
  }

  protected finalText(stdout: string): string {
    let final = "";
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const event = parseJsonText(line, "Codex CLI event") as Record<string, unknown>;
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
          final = item.text;
        }
      } catch {
        // Provider progress is deliberately ignored; only a final public message crosses the boundary.
      }
    }
    return final || stdout;
  }

  protected override providerUsage(stdout: string): { readonly inputTokens?: unknown; readonly outputTokens?: unknown } {
    let inputTokens: unknown;
    let outputTokens: unknown;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const event = parseJsonText(line, "Codex CLI usage event") as Record<string, unknown>;
        if (event.type !== "turn.completed") continue;
        const turn = event.turn && typeof event.turn === "object" ? event.turn as Record<string, unknown> : undefined;
        const usage = (event.usage && typeof event.usage === "object" ? event.usage : turn?.usage) as Record<string, unknown> | undefined;
        inputTokens = usage?.input_tokens ?? usage?.inputTokens;
        outputTokens = usage?.output_tokens ?? usage?.outputTokens;
      } catch {
        // Non-JSON provider diagnostics carry no trustworthy usage receipt.
      }
    }
    return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
  }
}

export class ClaudeCliMindAdapter extends CommandMindAdapter implements AgentAdapter {
  readonly adapterClass = "agent" as const;
  readonly capability: CapabilityCard = {
    id: "mind.claude-cli.v1",
    kind: "mind",
    displayName: "Claude CLI",
    version: "1",
    transport: "process",
    trust: "quarantined",
    modalities: ["text", "structured-data"],
    network: "provider",
    canExecuteTools: false,
    deterministic: false,
  };
  protected readonly defaultCommand = "claude";

  protected args(): string[] {
    return [
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--permission-mode",
      "plan",
      "--permission-prompts",
      "none",
      "--tools",
      "",
      "--strict-mcp-config",
      "--safe-mode",
      ...(this.options.model ? ["--model", this.options.model] : []),
    ];
  }

  protected finalText(stdout: string): string {
    try {
      const result = parseJsonText(stdout, "Claude CLI response") as { result?: unknown };
      return typeof result.result === "string" ? result.result : stdout;
    } catch {
      return stdout;
    }
  }

  protected override providerUsage(stdout: string): { readonly inputTokens?: unknown; readonly outputTokens?: unknown } {
    try {
      const result = parseJsonText(stdout, "Claude CLI usage response") as { usage?: Record<string, unknown> };
      const inputTokens = result.usage?.input_tokens ?? result.usage?.inputTokens;
      const outputTokens = result.usage?.output_tokens ?? result.usage?.outputTokens;
      return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
    } catch {
      return {};
    }
  }
}
