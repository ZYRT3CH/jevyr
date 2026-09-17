# Claude Agent SDK harness

The optional dependency `@anthropic-ai/claude-agent-sdk` is pinned to `0.3.261`. Select this harness before daemon startup:

```text
JEVYR_CLAUDE_ENABLED=1
JEVYR_CLAUDE_TRANSPORT=agent-sdk
JEVYR_CLAUDE_MODEL=<explicit configured Claude model>
JEVYR_CLAUDE_SDK_API_KEY_REF=env:ANTHROPIC_JEVYR_KEY
```

The named variable supplies an API credential through the existing audience-bound secret broker for `https://api.anthropic.com`. No ambient Claude login, host profile or unrelated credential is loaded. The adapter's public capability card includes the pinned harness policy digest and configured model; it contains no key. Provider inference can incur the configured provider's charges and remains subject to sealed Case token and wall ceilings.

This uses the actual SDK `query` loop and an in-process SDK MCP server. When the presealed invocation permits investigation, the fixed Judge-owned tools expose only the bounded sealed subject projection and public evidence: list files, read lines, search text, find indexed symbols, inspect public evidence, list sealed experiment templates, list critical obligations and inspect committed revision-parent source when supplied. They call the same `executeInvestigatorTool` implementation as the bounded raw-model investigation loop. Tool argument/result digests, status, result bytes and aggregate provider rounds are retained in the public investigation receipt. They do not execute experiments or acquire evaluator authority.

Every invocation receives a fresh temporary working directory and a replacement child environment. SDK built-in tools are disabled with `tools: []`; only the exact custom MCP names from the sealed tool policy are allowed. Ambient settings, plugins, hooks, agents, other MCP servers and persistent sessions are disabled. Host shell, filesystem, browser and network tools are unavailable. The SDK transport still contacts its model provider, and this adapter boundary is not an operating-system sandbox for malicious replacement SDK binaries. Executable evidence remains a separate Forge operation.

Calls have bounded rounds, context tool calls, captured output bytes, wall time and cumulative tokens. The final response must pass the existing closed structured-contribution parser; malformed output or incomplete usage fails the invocation. Private reasoning events are never published. All contributions remain hypotheses, with deterministic Bone holding the verdict authority.

The probe initializes the genuine SDK subprocess without yielding a user prompt or making a model inference request. A successful probe establishes installed harness availability; its message explicitly leaves credential and inference availability unproven. A real live model run is separate empirical evidence. The implementation was checked with hermetic tool-loop tests and a successful local native SDK initialization; no Claude inference was used for those checks.

If the optional SDK is unavailable, explicitly set `JEVYR_CLAUDE_TRANSPORT=cli` (or omit the transport) to use the existing restricted Claude CLI adapter on the next startup. A sealed invocation never silently changes transports. These controls follow the [official TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) and [SDK permissions documentation](https://code.claude.com/docs/en/agent-sdk/permissions).
