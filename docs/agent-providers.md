# Configuring investigators

For visual local-model discovery, cloud credential selection and MCP setup, open
**Connections** in the Chamber and follow the [connection setup guide](provider-connections.md).
Saving there replaces the HTTP model selection at the next startup; native agent
harnesses retain their separately configured environment. The examples below
describe environment setup when no visual HTTP profile has been saved.

Configure providers in the environment of the daemon **before startup**. An
existing daemon keeps its selected adapters, models, capability identities and
transport choices. Changing a variable in a second terminal does not change an
already sealed Case. Stop the daemon you started and restart it to apply a new
configuration. These examples assume `pnpm install` and `pnpm build` have run.

The examples use PowerShell. Replace model placeholders with an installed or
account-available model identifier. They do not install models, purchase access,
copy application login state or supply an API key. Secret values belong in the
explicitly named process environment supplied by your own secret manager; only
their references belong in configuration. Do not put keys in a Cast, source file,
URL, command argument or public artifact.

## Choose a harness

| Configuration | Who drives the tool loop | Available work | Provider authority |
| --- | --- | --- | --- |
| Codex app-server | Pinned native Codex agent | Fixed Judge context inspections, then a structured proposal | No host execution or verdict authority |
| Claude Agent SDK | Pinned Anthropic SDK agent | Fixed Judge MCP context inspections, then a structured proposal | No built-in host tools or verdict authority |
| Ollama / LM Studio / compatible HTTP model | Judge's bounded `ModelAdapter` loop | The same sealed context handlers using native function calls or structured JSON requests | Text generation only; Judge mediates every tool request |
| Claude CLI fallback | One restricted CLI invocation | Structured proposal from the bounded prompt | No host tools; not the SDK context-tool harness |
| RuleMind fallback | Deterministic local templates | Exercises lifecycle wiring when no provider is configured | Not a language model or evidence of heterogeneous reasoning |

Agent harnesses are genuine native agent transports. Their allowed tools are
Judge-owned, in-process readers of the authorized captured-source catalog,
public evidence, critical obligations, experiment templates and committed
revision-parent source. Paginated listings and bounded reads can reach permitted
sealed CAS bytes beyond the prompt projection budget; policy-excluded material
remains unavailable.
They cannot resolve a live filesystem path, run a command or fetch a URL. Actual
source inspection produces argument/result/source digests; claiming to have read
source cannot replace those receipts. Only the separately sealed Forge can run
an experiment and supply executable evidence. `canExecuteTools: false` describes
the absence of provider host execution, not the absence of context inspection.

The common source-inspection prompt is neutral about the tool channel. Codex
uses its registered native dynamic tools; Claude Agent SDK uses its registered
Judge MCP tools. They do not decode the HTTP loop's `jevyr.context-tools/1`
JSON batches or receive its response-format schema. Both native harnesses check
actual inspection receipts and parse the final contribution envelope under their
own bounded contracts. These distinctions do not establish credentialed model
inference or qualification for either native provider.

## Local Ollama or LM Studio

Use an already running local model service with its OpenAI-compatible `/v1/`
endpoint. The selected model must already be available there. No secret reference
is required for an unauthenticated loopback service.

```powershell
$env:JEVYR_PROJECT_ROOT = (Get-Location).Path
$env:JEVYR_OLLAMA_MODEL = '<installed-model-id>'
$env:JEVYR_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1/'
$env:JEVYR_OLLAMA_MODEL_FAMILY = '<declared-model-family>'
$env:JEVYR_OLLAMA_INVESTIGATION_TRANSPORT = 'structured'
pnpm --filter @jevyr/daemon start
```

For LM Studio, use the corresponding variables:

```powershell
$env:JEVYR_PROJECT_ROOT = (Get-Location).Path
$env:JEVYR_LMSTUDIO_MODEL = '<loaded-model-id>'
$env:JEVYR_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234/v1/'
$env:JEVYR_LMSTUDIO_MODEL_FAMILY = '<declared-model-family>'
$env:JEVYR_LMSTUDIO_INVESTIGATION_TRANSPORT = 'structured'
pnpm --filter @jevyr/daemon start
```

`native` is the default HTTP investigation transport and requires native function
calling and strict JSON response-format support from the selected endpoint.
It accepts either authorized native calls or declared `jevyr.context-tools/1`
JSON requests. The latter can batch up to four required-file reads in one round;
native parallel calls remain disabled. `structured` requests those closed JSON
responses and sends no native function definitions. Both channels use the same
tool handlers, disclosure limits and receipt checks. A request is never evidence
that the requested read happened.

Both HTTP transports share the final schema for the assigned stage: DIVERGE
requires exactly one finite candidate with the sealed command and entry file
when an experiment socket is available; INTERPRET permits interpretation, claim,
observation or test-plan contributions; a revision permits exactly one candidate
or Reflex assessment and constrains parent IDs to committed parents. Other stages
use the general contribution envelope, with at most six contributions. While
mandatory source inspection is incomplete, the declared JSON response schema
admits context requests. The last round requires the final contribution schema,
and the native request omits callable tools entirely. Actual source receipts,
strict final parsing and resource bounds still govern admission, including an
early final. There is no silent transport switch during a run. Family labels are
explicit provenance, not evidence of
independent reasoning; seed enforcement by external models remains unverified.
Configuring both services admits both adapters. Clear unused activation variables
before startup if you intend to select just one.

Revision instructions now prioritize one complete executable repair of the exact
generated parent. An honest Reflex refusal remains available when no admissible
repair can be justified. Task-authorized application changes belong in the generated
candidate; captured original bytes, supplied expected outputs and the sealed
evaluator remain fixed. A task observing original behavior must not substitute
a corrected source copy. The unchanged parser still accepts either a finite
candidate or a Reflex assessment; the wording does not grant extra rounds,
resources or authority. [Seven new prompt-contract groups and 48 existing tests
passed](../artifacts/revision-prompt-cohort-preparation-1788608532141/source-validation.json),
including a non-audit application repair and privacy/refusal cases.

The historical [native GPT-OSS checks](../artifacts/gpt-oss-built-native-bound-entry-summary.json)
used the actual compiled adapter with two unchanged held source tasks. Both
satisfied the structural output contract; one met the complete fixture
criterion and the other omitted an imported dependency. These are bounded
source-investigation measurements, not physical execution proofs or a claim
of general repair reliability. Earlier malformed responses remain retained.

The latest measured compiled [four-attempt lifecycle cohort](../artifacts/live-model-qualification-production-launch-1788608737491/recovery-strict-verification.json)
qualifies **1/4**: Qwen's clean fixture produced a correct first probe and a signed
VALID/ACCEPT. Qwen uses native HTTP transport and GPT-OSS uses structured HTTP
transport on the same clean and planted-defect clamp fixtures; neither profile
changed. All four signed exports independently replay. The [summary](../artifacts/live-model-qualification-production-launch-1788608737491/summary.json)
records 21 logical calls, six failed calls, 59 started provider rounds
(38 returned plus 21 failed), and eight distinct Docker invocations. There are
nine sandbox evidence events; these are not nine physical executions.

The other three probes imported an undelivered relative `./clamp.mjs` and exited
with `ERR_MODULE_NOT_FOUND`. Their Cases ended INVALID/NOT_APPLICABLE after
provider contract failures. All four immutable-source tests observed the correct
clean or defective behavior. Three feedback calls produced no admitted revision:
Qwen failed final contribution validation, and GPT reached its tool-round ceiling
twice. The [predeclared recovery diagnostic](../artifacts/live-model-qualification-production-launch-1788608737491/recovery-measurement.json)
measured all four attempts: one correct first probe, one correct selected probe,
zero correct revised probes. No successful model repair was measured, and the
first-probe success does not establish a causal effect of the revised wording.
See [exact delivery failures and limits](../artifacts/live-model-qualification-production-launch-1788608737491/delivery-analysis.json).

The [cohort preservation check](../artifacts/live-model-qualification-production-launch-1788608737491/implementation-after.json)
verifies all 929 files of its [compiled freeze](../artifacts/production-launch-installed-freeze.json)
and investigation identity `sha256:5974978c18f2862c3be54c1328821880c2144a0b7cb25538c3c95b319eda820b`.
This is the measured cohort build, not a claim about a later app/CLI freeze.
No retries, removed failures, native-profile GPT follow-up or historical rescoring
occurred. The proposed native-profile comparison remains unexecuted.

Failed HTTP calls now retain a closed diagnostic category, status where available,
and bounded response-byte digest, count and completeness flag. A partial digest
identifies only the captured prefix. Response bodies, prompts, credentials and
exception causes are not retained in that diagnostic. Retryability is only a
status-based hint; it never starts a retry. The latest cohort's one HTTP 500
retained a 648-byte response fingerprint; its backend cause remains unknown.
A separate [fixture-only diagnostic](provider-diagnostic-2026-09-05.md) retained
a different 300-byte error identifying malformed generated tool-call JSON.
That cause applies only to that diagnostic, not every historical or later 500.

The immediately preceding [execution-feedback cohort](../artifacts/live-model-qualification-recovery-1788606576233/summary.json)
remains historical at 0/4, with four valid independent replays, 22 logical calls,
seven failures, 57 provider rounds and four distinct Docker invocations. The older
[original-subject installed cohort](../artifacts/live-model-qualification-original-subject-installed-1788604073418/independent-verification.json)
also remains 0/4, with 23 calls, three failures, 67 provider rounds and eight
Docker invocations. Its captured-output and comparative-repair limitations were
subsequently corrected; those corrections do not retroactively qualify its cases.
The current feedback path and finite validation are described in
[autonomous investigation](autonomous-investigation.md).

The preceding [transport-consistency 0/4 cohort](../artifacts/live-model-qualification-transport-consistency-1788597452520/independent-verification.json)
remains historical. Its seven failed calls and four Docker observations describe
that earlier implementation, not this installed measurement.

The earlier [corrected one-of-four cohort](../artifacts/live-model-qualification-reference-files-1788595865634/corrected-independent-verification.json)
and its [original zero-of-four report](../artifacts/live-model-qualification-reference-files-1788595865634/report.json)
remain historical. That correction fixed an initial-population artifact binding
in the verifier without changing inference, fixtures or criteria. The latest
cohort is a separate retained experiment, not a replacement or a success-only
selection. Neither small cohort establishes general repository quality, model
ranking or a causal effect of a particular code change.

The separate [installed original-subject proof](../artifacts/original-subject-installed-lifecycle-1788604306738/independent-verification.json)
verifies three actual HTTP/Docker cases under the narrow Bone v2 path: supported
clean assertions ACCEPT, a planted assertion defect REJECT, and unsupported source
UNPROVEN. It uses the exact intent `Existing tests must pass.` and independently
reconstructs a bounded pure-assertion certificate over original captured bytes.
Creation and embodiment remain FAILED/NOT_BUILT when no candidate was built.
This is a host evaluator capability, not evidence that a language model qualifies;
ordinary Node test-runner counts still grant no authority. See the exact
[applicability and authority boundary](repository-evaluator-authority.md).

For a different compatible endpoint, set both
`JEVYR_OPENAI_COMPATIBLE_MODEL` and `JEVYR_OPENAI_COMPATIBLE_BASE_URL`.
`JEVYR_OPENAI_COMPATIBLE_INVESTIGATION_TRANSPORT` accepts the same two values;
`JEVYR_OPENAI_COMPATIBLE_MODEL_FAMILY` supplies declared family provenance.
Non-loopback endpoints additionally require
`JEVYR_OPENAI_COMPATIBLE_ALLOW_REMOTE=1`. For this compatibility adapter,
`JEVYR_OPENAI_COMPATIBLE_CREDENTIAL_REF=JEVYR_COMPATIBLE_KEY` names the variable
**without** an `env:` prefix. The broker captures only that variable and binds
its use to the configured endpoint's origin. New configurations should use this
reference instead of the legacy `JEVYR_OPENAI_COMPATIBLE_API_KEY` setting.

## Codex app-server

Arrange for `JEVYR_OPENAI_KEY` to be present in the daemon's process environment
through your secret manager. Then configure its audience-bound reference:

```powershell
$env:JEVYR_PROJECT_ROOT = (Get-Location).Path
$env:JEVYR_CODEX_APP_SERVER_ENABLED = '1'
$env:JEVYR_CODEX_MODEL = '<explicit-model-id>'
$env:JEVYR_CODEX_API_KEY_REF = 'env:JEVYR_OPENAI_KEY'
pnpm --filter @jevyr/daemon start
```

The native contract is pinned to the locally measured Codex **0.153.1**. A
different runtime version fails the configuration probe. The adapter uses
`app-server --listen stdio://`, a fresh provider home, a separate empty context
directory and a replacement child environment. It checks the native
`config/read` response before login, and the named filesystem permission profile
and exact model before a model turn. Host commands, network tools, shell login,
ambient skills, plugins, hooks, MCP discovery and other agents are disabled.
Only the fixed context tools are registered. Authentication uses the explicit
broker reference for `https://api.openai.com`; ambient ChatGPT/Codex login and
home configuration are not imported.

On Windows, the launcher first resolves a native executable from absolute PATH
entries. It can also resolve the known npm package's bounded manifest to its
native executable or Node entrypoint. It never evaluates `.cmd` or PowerShell
shims and always uses `shell: false`. The observed desktop native binary was
0.153.1; a separately installed npm Codex was 0.146.1 and cannot satisfy this pin.
Select a PATH containing the intended trusted native installation.

`JEVYR_CODEX_ENABLED=1` selects the older CLI compatibility adapter, whose
inference is now deliberately closed because its old flags did not establish
the required isolation. It is not an alias for the app-server. Remove that old
activation variable when selecting the new harness. The native Windows
restricted-token sandbox refused synthetic command execution when it could not
enforce split filesystem read restrictions; it did not fall back to unrestricted
execution. Judge context readers do not require those commands. Full boundary
details are in [CODEX_AGENT.md](../packages/runtime/CODEX_AGENT.md).

## Claude Agent SDK

Arrange for `ANTHROPIC_JEVYR_KEY` to be supplied to the daemon by your secret
manager, then use the explicit SDK selection and reference:

```powershell
$env:JEVYR_PROJECT_ROOT = (Get-Location).Path
$env:JEVYR_CLAUDE_ENABLED = '1'
$env:JEVYR_CLAUDE_TRANSPORT = 'agent-sdk'
$env:JEVYR_CLAUDE_MODEL = '<explicit-Claude-model-id>'
$env:JEVYR_CLAUDE_SDK_API_KEY_REF = 'env:ANTHROPIC_JEVYR_KEY'
pnpm --filter @jevyr/daemon start
```

The optional dependency `@anthropic-ai/claude-agent-sdk` is pinned to **0.3.261**.
Its real `query` loop receives a fresh directory, replacement environment,
`tools: []`, no ambient settings and only the exact Judge MCP tool names.
The credential audience is `https://api.anthropic.com`. Native host tools,
additional MCP servers, hooks, persistent sessions and imported Claude login
state are unavailable to this SDK configuration. Missing explicit credentials
refuse inference; a successful initialization probe does not prove authentication.

`JEVYR_CLAUDE_TRANSPORT=cli`, or omitting the transport with Claude enabled,
selects the separate restricted CLI fallback. It uses `--safe-mode`, an empty
tool list and strict MCP configuration, and may use the CLI's own existing
provider authentication. It does **not** gain the SDK's context-tool loop or
replacement-home credential boundary. The observed CLI version was **2.1.259**;
the CLI fallback is not version-pinned like the SDK. No sealed invocation
silently switches between them. See
[CLAUDE_AGENT_SDK.md](../packages/runtime/CLAUDE_AGENT_SDK.md).

## Privacy, budgets and checking a configuration

`local_only` permits only adapters whose declared network is `none` or
`loopback`. It excludes both remote native agents even though their subprocesses
run on this machine. If all configured minds are excluded or unavailable, the
Case cannot become a successful remote-model run; it does not silently add
RuleMind or change privacy. Use an admitted local model for local-only work.

`provider_scoped` admits remote providers but withholds direct subject text and
revision-parent source from them. They still receive the public Case prompt,
constraints and admitted public facts. This mode is not a promise that all
information derived from source is secret. `full_case` permits bounded reads of
authorized captured source for configured providers, including text outside the
initial prompt projection. Every mode uses synthetic subject locators; catalog,
scan, read and output limits remain explicit. Binary and policy-excluded bytes
do not become readable through an omitted-file entry. Choose privacy before sealing, in Airlock or with
`pnpm jevyr cast "..." --privacy local_only|provider_scoped|full_case`.

From another terminal, `pnpm jevyr doctor --json` reports the running daemon's
actual configured capabilities and readiness. Installation, initialization,
credential availability and successful model inference are separate facts.
Input/output tokens, raw capture, context calls, rounds and wall time are
bounded by the invocation and Case budgets. Failed native turns retain a
conservative repeated-context input charge, including tool responses, without
publishing prompts or credential-bearing diagnostics. No adapter can approve a
Case or change Bone's verdict.

The retained no-inference probes are
[agent-harness-probes-1788580936815/report.json](../artifacts/agent-harness-probes-1788580936815/report.json)
and [codex-boundary-probe-1788581356922/report.json](../artifacts/codex-boundary-probe-1788581356922/report.json).
They measured Codex isolated initialization at 215 ms, Claude CLI discovery at
47 ms and genuine Claude SDK initialization at 1282 ms on this machine. The
second report records native permission/configuration acknowledgement and safe
execution refusals. **No Codex or Claude model inference was performed in those
probes.** Tool-loop behavior and failure metering also have hermetic tests;
neither those tests nor startup success establish live heterogeneous-case
quality. Runtime and protocol details follow the installed native schemas and
the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
and [Claude Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript).
