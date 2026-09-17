# Jevyr operations

The display name is Jevyr and `pnpm jevyr` is the preferred command alias. Existing `jevyr` commands, `.jevyr` stores and wire identifiers remain supported.

## Install and start

```bash
corepack enable
pnpm install
pnpm build
pnpm dev
```

`pnpm dev` runs the loopback daemon on port `4317` and the Chamber on port `3001`. Override the client endpoint with `JEVYR_URL`; override the Chamber endpoint with `JEVYR_CHAMBER_URL`.

Initialize Jevyr in any repository or local folder:

```bash
pnpm jevyr init /path/to/project
```

Initialization creates only five known Jevyr-owned files: `.jevyr/config.json`, `.jevyr/policy.json`, `.jevyr/assay-frontier.json`, `.jevyr/.gitignore`, and the project-root `.jevyrignore`. The generated Assay Frontier contains the finite `node jevyr.experiment.mjs` experiment. It supplies an execution socket, not automatic proof of a broad natural-language claim: decisive judgment requires a matching sealed oracle. An explicitly empty `assays` array authorizes no embodiment or selection. Without `--force`, initialization never replaces an existing file. With `--force`, replacement is still confined to those five exact targets.

The daemon reads policy only from `<explicit project root>/.jevyr/policy.json`; it never walks into a parent directory or a home directory. Set `JEVYR_PROJECT_ROOT` when the daemon is started outside the target project. Relative `JEVYR_DATA_DIR`, Assay Frontier or legacy Forge-plan, and MCP-witness paths resolve from that root. Unknown policy fields and attempts to enable continuation, writable source, Forge networking, trusted-host fallback, live Bone mutation, or automatic growth promotion stop startup.

## Genome startup and governance

The default registry is `<data-dir>/genome-registry`; set `JEVYR_GENOME_REGISTRY_DIR` to an explicit alternative (relative values resolve from the project root). With no active pointer, startup binds the built-in `jevyr.genome/1` baseline descriptor explicitly. It does not infer a learned Genome.

An active pointer is accepted only when its immutable Genome, proposal, promotion, and DSSE chain all verify. Configure the public trust roots with `JEVYR_GENOME_GOVERNANCE_TRUST_FILE`:

```json
{
  "protocol": "jevyr.genome-governance-trust/1",
  "keys": [
    {
      "keyId": "sha256:<SPKI digest>",
      "algorithm": "Ed25519",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
    }
  ]
}
```

The parser rejects unknown fields, duplicate or mismatched key IDs, non-Ed25519 keys, private-key PEM, symlinked files, unstable reads, invalid UTF-8, and files over 1 MiB. The sealed policy provenance includes only public-key fingerprints, never the trust-file path.

The daemon reads the active pointer exactly once, before it constructs the Case repository. Every Case accepted by that daemon therefore uses the same concrete `genomeVersion` and `genomeDigest`. A separately governed pointer change affects only a daemon started afterward. Startup selection does not stage or promote a descendant. An explicitly enabled repository self-judgment watcher may later store a quarantined request after a signed Case independently verifies a binding failure or critical defect; it has no promotion or activation authority.

Set `JEVYR_SELF_JUDGE=1` to enable that watcher and optionally set `JEVYR_SELF_JUDGE_INTERVAL_MS` between 10,000 and 3,600,000 milliseconds (default 60,000). `JEVYR_SELF_JUDGE_CASE_FILE` selects a strictly bounded mission containing only impulse, constraints, and requested assays; its startup digest is bound into every source manifest. A real repository test requires an applicable immutable source assay in the startup frontier. The default generic mission can remain `UNPROVEN`. The watcher runs one immutable source snapshot at a time, ignores unchanged source and generated state, and submits `local_only` / `sovereign` Cases. Shutdown aborts only its active Case. Offspring lacking benchmark evidence remain rejected, and a static baseline produces an explicit request for a governed parent. See [the capture limits, exclusions, and proposal contract](self-judgment.md).

The daemon compiles an authenticated promoted Genome against Jevyr's runtime-owned Bone digest. Only the closed built-in catalog of bounded nursery, archive, and late-memory numeric knobs is accepted; unknown code, permissions, fields, and out-of-range values fail startup.

Precedence is one-way. Project policy keeps physical resources, attempt ceiling, minimum attempts, lineages, and seed derivation. Genome may only lower saturation, shorten challenge cadence, lower the `4096` archive capacity, raise its `0` novelty floor, lower the `12`-item recall cap, and lower the project's maximum late-memory weight. The compiled profile and composed runtime-growth-policy digests are sealed. Zero recall or weight prevents memory exposure; a nonzero weight is a cap on recorded attribution, not a claim that Jevyr can measure model attention.

## Memory staging and later evidence

At `MEMORY_TRIBUNAL`, the daemon stages the exact project-memory candidate committed in the signed Record prefix. It does not grant `ADMIT` from the origin run. After Bone-authored terminal closure, the Case is authenticated as a possible later observation of older staged candidates. The daemon compares only exact task/material and exact policy/Genome/Search/Assay mechanism fingerprints. Before contamination can pass, it reconstructs the bounded transitive closure of the target ancestry and every source Record memory influence, and independently verifies each ancestor's candidate hash, observation snapshot, and re-derived `ADMIT`. The source closure must be disjoint from the target memory and its closure. Exact clean outcomes append reproduction plus passing-contamination observations; a different exact outcome appends a counterexample; changed task, changed mechanism, non-later chronology, project mismatch, shared lineage, and missing, cyclic, over-limit, cross-project-incompatible, or unverifiable lineage remain public exclusions with no Tribunal edge.

Reconciliation artifacts and one summary artifact are stored in the later Case and named by the terminal `memory.reconciliation` action. Identical submissions normally share a `caseDigest`, so independence is counted by the signed `runDigest`; two distinct later source runs are required. Restart repeats the stable operation safely and verifies existing observations, snapshots, and decisions instead of trusting a no-op. Operators should inspect the reconciliation summary for reproduction, counterexample, exclusion, pending, admitted, and rejected counts. There is no arbitrary evidence-write endpoint, and the daemon's exported memory handle is read-only.

## Diagnose capabilities

```bash
pnpm jevyr doctor
pnpm jevyr doctor --json
```

The report probes the daemon, Git, Docker, Codex, Claude, Ollama, and LM Studio. Availability is evidence about this installation, not evidence that a Case’s claims are true.

## Cast and observe

```bash
pnpm jevyr cast "One complete thought."
pnpm jevyr cast --file impulse.txt --subject git:/absolute/repository/path
pnpm jevyr watch CASE_ID
pnpm jevyr watch CASE_ID --tui
pnpm jevyr watch CASE_ID --cursor 0 --json
pnpm jevyr open CASE_ID
```

Subjects use `kind:locator`; supported kinds are `git`, `directory`, `file`, `url`, `text`, and `artifact`. Newly initialized local CLI projects default to `local_only` privacy and `juggler` control; existing saved choices are preserved. Airlock also defaults to Juggler. Benchmarks and the advisory Action explicitly use Sovereign, and a direct SDK Cast retains its conservative Sovereign default. There is no continue command.

`watch --tui` authenticates the Seal before displaying its obligations. Tab switches between the overview, claims, committed lanes, and metabolic balls; arrow keys scroll claims or lanes. Public proposals remain labeled separately from sealed obligations. Live assay reports and lineage commitments come from the same ordered event stream as ordinary `watch`; they are observations, not a completed evidence replay. A nonzero `--cursor` shows only the later live reports.

For a sealed Juggler Case, the TUI verifies current offers and signed receipt history, then shows each available ball's per-unit resource ceiling. Press its displayed number to inspect the measured scope and enter an offered integer quantity; Enter sends exactly the opaque ball ID and quantity once. Escape cancels quantity entry. The SDK verifies the returned signed receipt. An uncertain response disables further additions until `r` successfully refreshes signed history; it never retries the write automatically. Sovereign Cases have no metabolic controls, and ordinary `watch` remains read-only. `q`, Escape outside quantity entry, Ctrl-C, or SIGTERM closes the observer and leaves the Case running.

Before the Cast returns, Jevyr captures every available subject into its private content-addressed material store and persists the per-Case binding before making the Case schedulable. Remote Git and default URL inputs are recorded as declaration-only. The signed `subjectMaterialCaptureDigest` covers both forms. Later source edits cannot enter the run; a missing manifest, changed blob, or missing legacy binding fails closed.

Every mind sees synthetic subject locators. In `provider_scoped`, provider-network and unrestricted adapters receive no direct subject text projection, while local and loopback adapters may receive the bounded projection read from captured bytes. `full_case` permits that projection for configured minds. `local_only` excludes provider-network minds entirely. Files that are binary, excluded, declaration-only, or outside the projection limits appear as omissions rather than silently truncated text.

The live client validates each event's exact discriminator-specific shape and verifies sequence, case/run identity, prior digest, recomputed event digest, and forward-only lifecycle progression. SSE is preferred. A disconnect resumes from the accepted numeric cursor through bounded long polling. `jevyr watch` then authenticates the Seal, crystallized Record, and terminal receipt under one trusted key; proves the Record head is a prefix of the complete observed ledger; and requires the receipt to bind that exact final head and status projection plus the canonical Record and artifact-index digests. It prints the verdict as a recorded claim together with `persisted-evidence=not-replayed`: the exact inventory is authenticated, but its evidence has not been replayed. A zero exit status means observation and authentication completed; it is deliberately independent of the signed `verdict.integrity` value. Use `jevyr replay CASE_ID` for a complete evidence-validity result and corresponding validity exit status.

The CLI can seal the complete public Case contract without editing generated files: repeat `--subject KIND:LOCATOR`, `--constraint TEXT`, and `--requested-assay TEXT` as needed, and choose `--mode auto|audit|design`, `--privacy`, and `--control`. These are all pre-Cast fields; none creates a continuation channel.

## Replay and compare

```bash
pnpm jevyr replay CASE_ID
pnpm jevyr replay record.json --events events.json --intent-contract intent-contract.json --unsigned-diagnostic
pnpm jevyr compare LEFT_CASE_OR_RECORD RIGHT_CASE_OR_RECORD
```

Remote replay retrieves the public trust bundle and verifies the signed Seal, crystallized Record, and terminal receipt under the same key. It requires the terminal receipt to match the exact final status projection and complete ledger, name the canonical Record and artifact-index digests, and contain the Record's crystallization head as a ledger prefix. It also validates the canonical IntentContract against the Seal's authenticated digest before deterministic replay. Sandbox authority additionally requires the exact policy descriptor and the content-addressed ToolObservation bytes: replay re-evaluates those bytes against the sealed Assay Frontier instead of trusting event labels. A bare local `record.json` has no signature context and is refused unless `--unsigned-diagnostic` is explicit; that mode additionally requires the event ledger and exact IntentContract, checks their structure and deterministic replay, but makes no authenticity claim. If sandbox evidence is present but its descriptor and artifacts are unavailable, the diagnostic is incomplete rather than valid. Replay does not rerun stochastic minds. Comparing two executions is explicitly different from replaying one execution.

## Offline proof bundles

An exported GitHub advisory proof bundle can be verified without a running daemon. The companion workflow publishes one tar file; extract it into a fresh directory first, then verify that directory:

```bash
pnpm jevyr verify-bundle /path/to/bundle \
  --trusted-key-id sha256:<externally-pinned-key-id> \
  --expected-runtime-sha <full-lowercase-git-object-id> \
  --expected-subject-sha <full-lowercase-git-object-id> \
  --expected-workflow-sha <full-lowercase-git-object-id>
```

The verifier inventories the closed version-1 layout, checks that `MANIFEST.sha256` names every and only regular file, authenticates the Seal, Record, and terminal envelopes under one key, reconstructs the sealed contract and provenance, verifies the exact final event, status projection, Record, and artifact-index closure, hashes every indexed body, and runs fresh persisted-evidence replay against the exported bytes. Expected Git object IDs are optional additional provenance constraints.

The trust key shipped inside a bundle proves only internal signature consistency. Without `--trusted-key-id`, an otherwise intact bundle prints `UNANCHORED`, reports `trust=bundle-declared-key`, and exits `7`; it is not accepted as valid. A fully verified bundle exits `0` only when the authenticated key equals the independently obtained key ID and every supplied provenance expectation matches. Integrity, trust-anchor, malformed expectation, and expectation-mismatch reports exit `7`. Omitting the required directory or failing before a verification report exists uses the CLI's general error exit `1`.

## Benchmarks

```bash
pnpm jevyr benchmark --validate-only
pnpm jevyr benchmark
node benchmarks/runner.mjs --validate-only
```

The corpus tests constitutional failures, evidence authority, impossible requests, preference invariance, memory contamination, source conflict, and descendant quarantine. The rejected Chamber visual is not a benchmark case.

## Assay Frontier and Forge modes

Set `forge.engine` to `"docker"` (default) or `"podman"` in project policy before daemon startup. Both use the same OCI authority checks and bind the actual engine and immutable image identity. Podman support has engine-specific argument tests; a working Podman installation is required to measure it on a target machine.

The release policy treats a missing or failed promised sandbox, provider failure, or loss of a promised capability as an integrity failure (`INVALID`). Legacy `missingDocker: "UNPROVEN"` files are normalized to `"INVALID"` when loaded and that effective policy is sealed. An ordinary failing candidate command is evidence about that candidate, while a bounded deadline or unexecuted proposal can still leave judgment `UNPROVEN`.

The default is Docker: captured input read-only, writable disposable overlay, read-only container root, dropped capabilities, resource limits, denied network, and no implicit image pull. Before accepting Cases, daemon startup resolves the configured image reference once to Docker's immutable `sha256:` image ID and seals both the requested reference and resolution into policy. The frozen built-in Forge uses `docker create` with only that ID, inspects the concrete container's `.Image` before candidate code can start, and runs it only on an exact match. A missing daemon/image leaves Forge non-executing until restart; a mutable tag can never be re-resolved inside a Case.

During pre-Seal capture, each file or directory subject is filtered by the `.jevyrignore` at its source boundary. `.git`, `.jevyr`, `node_modules`, credential stores, `.env` variants, credential/private-key filenames, and detected private-key blocks are always excluded; `!` rules cannot re-include them. Links and filesystem-boundary crossings are refused, and `.jevyrignore` is UTF-8 and capped at 64 KiB. At `EMBODY`, Jevyr rehashes the Case binding and reconstructs only those captured bytes under synthetic roots. It never rereads the original subject locator.

- `JEVYR_FORGE_MODE=docker` — default, safe local execution boundary. `/subject` is the fresh verified reconstruction mounted read-only; `/work` is a distinct writable copy. The original subject path is never passed to Docker.
- `JEVYR_FORGE_MODE=observe-only` — record a proposed action without executing it.
- `JEVYR_FORGE_MODE=trusted-host` plus `JEVYR_ALLOW_TRUSTED_HOST=1` — explicit diagnostic mode; it still copies into a disposable workspace and starts with a small clean environment, but it has no sandbox verdict authority.

The primary configuration is the repository-local `.jevyr/assay-frontier.json`, which `jevyr init` creates and the daemon discovers without ambient configuration. `JEVYR_ASSAY_FRONTIER_FILE` selects an explicit alternative; a relative path resolves from the explicit project root. The loader requires a stable regular non-symlink file, rejects unknown fields, and canonicalizes assays by `assayId` before binding the complete frontier digest into effective policy:

```json
{
  "protocol": "jevyr.assay-frontier/1",
  "assays": [
    {
      "assayId": "tests.node",
      "costUnits": 1,
      "tool": "forge.command",
      "args": {
        "command": "node",
        "args": ["--test"]
      },
      "timeoutMs": 120000,
      "obligationId": "obl_0123456789abcdef0123"
    }
  ]
}
```

The optional `obligationId` must be the exact deterministic ID of a sealed assayable obligation. Digest fields for a sealed subject, sealed suite, or explicitly requested assay can bind a future specialized evaluator, but the current runtime has no immutable evaluator substrate for them and therefore blocks the cell before Forge. A digest-shaped result is never treated as an evaluation. `sourceRoot` and environment values are forbidden in this file. Aggregate Forge wall/CPU, total assay cost, writable bytes/inodes, and artifact bytes are copied from the sealed search resource envelope rather than supplied by an assay. Archive capacity and novelty are compiler-owned values from the sealed runtime growth policy; a promoted Genome may only tighten them.

`JEVYR_FORGE_PLAN_FILE` remains only as a strict compatibility bridge for the old single-plan shape (`command`, `args`, and optional typed bindings). It suppresses conventional-file discovery and is wrapped as one `legacy.default` assay before Cast. Setting it together with `JEVYR_ASSAY_FRONTIER_FILE` is an error.

A candidate may propose a finite `jevyr.candidate-blueprint/1` containing UTF-8 files and an optional no-shell argv. Jevyr compiles it immediately under the project-root `.jevyrignore` and the sealed write envelope. The effective policy stores the exact bounded ignore source beside its digest, so later replay recompiles the rules and rejects a self-consistent blueprint that was not actually legal under them. Unsafe or reserved paths, secret-like content, collisions, unknown fields, and authority-bearing fields are refused without deleting the abstract candidate. Once DIVERGE closes, Bone considers every admitted blueprint against every sealed assay. Each executable cell receives a new disposable root, with sealed subjects under its reserved `.jevyr-subjects` child; the root is removed after that call. Its worktree and Forge-owned HOME, temporary, cache, and shared-memory paths share one measured writable envelope; runtime scratch consumes physical budget but cannot masquerade as candidate output. Budget- or binding-blocked cells record refusal without execution. The proposed argv remains inert and is never substituted for a sealed assay plan.

Command success is only an observation. Candidate-scoped results and typed evaluations are published first without global support/refutation edges. Bone closes the measured quality-diversity archive, selects only from survivors with a complete passing assay set, and only then emits winner-scoped critical evidence against truth-conditional oracles in the sealed intent contract. If no candidate qualifies—or any resource limit truncates the complete frontier—nobody is selected and critical claims remain unproven. Neither a plan flag nor a model blueprint can declare itself decisive.

The ceilings are aggregate across the candidate × assay product. Bone measures Forge wall time itself, requires complete workspace accounting for archive admission, and records an exact per-cell/aggregate-after accounting object. CAS storage charges only new digests; resource-efficiency ranking charges the bytes each cell actually produced. `maxForgeCpuMillis` is declaration-only for the built-in Forge. Network bytes and concurrent lineage execution are not yet end-to-end metered. See [Assay Frontier v1](assay-frontier-v1.md).

See [sealed browser experiments](browser-probes.md) for the Playwright image, finite probe language, and the relationship between browser behavior, runtime coverage, and exact source hashes.

## Credentials and source indexing

For an OpenAI-compatible endpoint, configure `JEVYR_OPENAI_COMPATIBLE_MODEL`, `JEVYR_OPENAI_COMPATIBLE_BASE_URL`, and `JEVYR_OPENAI_COMPATIBLE_CREDENTIAL_REF`. The credential reference names an environment variable holding the credential. A startup-owned broker captures only that named value and authorizes its use only for the configured HTTP(S) origin. The value crosses the transport header boundary, never a mind prompt or public ledger. Remote endpoints additionally require `JEVYR_OPENAI_COMPATIBLE_ALLOW_REMOTE=1` and a compatible sealed privacy profile. The legacy API-key variable is adapted through the same broker.

During Self Scan, Tree-sitter indexes the verified text projection of sealed JavaScript, TypeScript, TSX and Python subjects. Symbol nodes bind their original source hashes and locations; JavaScript/TypeScript imports support bounded reverse dependency lookup. Unsupported languages, declaration-only subjects and byte/node limits are explicit omissions. The index is a persisted observation and supplies no verdict authority; syntactic dependency is not a causal finding.

The [generic stdin bridge](../packages/runtime/TEXT_STDIN.md) supports one-shot executables with structured output and bounded accounting. Such an executable is a host process and honestly declares unrestricted capabilities; an empty working directory and scrubbed environment do not constitute a sandbox.

Ordinary daemon startup takes Forge image, resource limits, denied networking, and read-only source behavior from `.jevyr/policy.json`. The old environment escape hatches are not operational policy inputs.

## MCP

```bash
pnpm jevyr mcp serve
```

The stdio server advertises `submit`, `status`, `result`, and `evaluate`.
`submit` seals one Case and immediately returns its receipt. `status` only reads.
`result` returns the exact Seal, Record and terminal envelopes with their public
trust bundle after durable closure. `evaluate` uses the same single Cast and
waits at most 30 seconds afterward; a pending response includes the existing
receipt and latest available status. Read `result` later instead of resubmitting.
Canceling the waiter does not reopen or cancel the sealed Case.

The historical `jevyr_cast`, `jevyr_status`, `jevyr_record`, and `jevyr_run`
call names remain compatibility handlers and are not advertised as new tools.
`jevyr_run` is a separate one-way
submission whose still-active originating call may answer bounded
`sampling/createMessage` requests; that sampled client model is isolated to the
new Case and never replaces the daemon's startup registry. Explicit
`provider_scoped` or `full_case` privacy is required because a loopback MCP
connection cannot attest where the client's model executes.

Jevyr sends exactly its prepared public prompt with `includeContext: "none"`
and grants no Sampling tools. The default temperature is 0.8, which encourages
candidate diversity but remains an advisory preference the client may change.
For future runs the adapter ceiling is 90,000 completion tokens. Bone sends
`min(adapter ceiling, sealed per-call output reservation)` and records that
exact request in the sampling receipt; the client may return less. Under the
default 131,072-token Case-wide output envelope and 12 remaining Mind slots,
the pristine first-call reservation is 10,923. A project that genuinely needs
larger calls must enlarge its exhaustive `search.resources.maxOutputTokens`
policy before daemon startup and Cast; neither the MCP host nor a sealed Case
can widen it. The 1 MiB transport frame and 2,000,000-byte adapter raw-output
ceilings still apply independently.

Jevyr may separately consume operator-configured MCP witnesses through `JEVYR_MCP_WITNESSES_FILE`. The file names absolute executables, explicit environment-variable names, allowlisted tools, and exact pre-Cast calls. Discovery cannot authorize a call. Credential values are excluded from public policy provenance. Results may become visibly quarantined context for later invention but receive no `supports` or `refutes` edge and therefore cannot make Bone accept anything.
