# Codex sealed context agent

Configure the native app-server before startup:

```text
JEVYR_CODEX_APP_SERVER_ENABLED=1
JEVYR_CODEX_MODEL=<explicit model>
JEVYR_CODEX_API_KEY_REF=env:JEVYR_OPENAI_KEY
```

The named variable is captured by the audience-bound secret broker for `https://api.openai.com`. Ambient Codex/ChatGPT login, home directories, environment credentials, proxy settings, and user configuration are not loaded. The adapter authenticates only in a fresh disposable provider home and deletes it after child termination. No provider key enters a contribution, capability card, command argument, public transcript, or diagnostic message.

The implementation uses the actual native app-server JSONL handshake and dynamic tool protocol. It is pinned to the measured `0.153.1` contract and fails closed on a different version. The installed binary's generated schema was used to check named permissions, dynamic tools, thread isolation, usage notifications and API-key login. Current [app-server documentation](https://learn.chatgpt.com/docs/app-server) also describes these fields; older installations may expose a different contract.

Every invocation creates an empty context directory and a separate private provider home. Its named filesystem profile permits minimal platform reads and reads of that context directory, with no write grants or network tools. Native shell, exec, browser, file-search, MCP discovery, plugins, hooks, host skills, other agents, and other listed host capabilities are disabled in fixed configuration. `config/read` must acknowledge those controls before login or a model turn. `thread/start` must acknowledge the named profile, provider, explicit model, exact directory, no imported instructions, and no execution environments. Automatic provider/model fallback is forbidden.

Only the fixed Judge-owned dynamic context tools are offered. They inspect the already-authorized sealed projection, public evidence, sealed experiment templates, critical obligations and, when supplied, committed revision-parent source. Their shared handler has no host filesystem/process/network resolver. Each actual inspection creates argument, result and source digests. Provider claims of inspection cannot substitute a receipt. All other server requests, including approvals, elicitation and host-tool requests, are denied.

Context calls, provider usage updates, raw capture, wall time and final structured output are bounded. A finite candidate must contain a complete source blueprint; only the Forge may execute the separately sealed experiment. Agent output has no evaluator authority. `canExecuteTools: false` describes the lack of host execution; context inspection remains available and is recorded separately. Native token metering and its rollout budget constrain the invocation; no paid inference has been measured by the no-auth probes described below.

On this Windows installation, native split filesystem restrictions cannot run host commands through the unelevated sandbox. Synthetic inside-read, outside-read and inside-write probes all refused execution instead of widening permission. This establishes safe refusal, **not** successful executable sandbox support. Context handlers do not require those commands. The provider process itself remains trusted installed software, not an OS container for a malicious replacement binary.

The legacy `JEVYR_CODEX_ENABLED` CLI adapter now refuses inference because its older flags did not establish equivalent isolation. Its probe can report the installed CLI version, but availability is false. Select the app-server explicitly; sealed invocations never switch transports. Claude's CLI fallback retains its verified safe-mode/no-tools arguments. On Windows, known npm provider entries are resolved through bounded package manifests to a native executable or Node entrypoint, with `shell: false`; arbitrary batch/PowerShell shims are never evaluated.

Retained local probe reports are in `artifacts/agent-harness-probes-*` and `artifacts/codex-boundary-probe-*`. They contain no user prompt or model inference. A successful startup probe proves the installed transport/configuration only; an explicit configured credential and successful live case are separate evidence.
