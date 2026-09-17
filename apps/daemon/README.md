# Jevyr daemon

The canonical local address is `http://127.0.0.1:4317`. The daemon binds to loopback by default, accepts localhost browser origins, and requires an explicit environment switch before it will bind remotely.

The service now runs on Fastify. See [Cast transports](./TRANSPORTS.md) for multipart uploads, JSONL, atomic drop bundles, A2A submission/progress, startup-bound peers, Genome Lab, and opaque Juggler vouchers.

Run it from the repository root:

```powershell
pnpm --filter @jevyr/daemon dev
```

Cast once:

```http
POST /v1/cases
Content-Type: application/json

{"protocol":"jevyr.case/1","case":{"impulse":"...","privacy":"local_only"}}
```

The `202` body is the exact canonical `jevyr.seal/1` receipt. Its required `subjectMaterialCaptureDigest` commits to the immutable private-CAS subject binding set captured before Seal; mutable source locators are not a substitute for that commitment. `Location` identifies the status resource and the HTTP `Link` header advertises observation surfaces. Its DSSE signature is available separately at `GET /v1/cases/{caseId}/seal/envelope`, keeping the receipt itself protocol-exact. No message, input, edit, approval, or continuation endpoint exists after this request.

## Live observation

For portable cursor polling:

```http
GET /v1/cases/{caseId}/events?after=18&waitMs=30000&limit=500
```

The response is the exact `jevyr.live/1` envelope: `caseDigest`, `runDigest`, `afterSequence`, `throughSequence`, `headDigest`, `caughtUp`, ordered `events`, and `polledAt`. Use `throughSequence` as the next cursor. Cursor `0` means before the first event; event sequences begin at `1`. Each event also carries a `sha256:`-prefixed prior digest and content digest, so mutation or reordering invalidates the ledger.

For immediate streaming:

```http
GET /v1/cases/{caseId}/events/stream
Accept: text/event-stream
Last-Event-ID: 18
```

SSE emits each canonical event as a default browser `message` with a numeric event ID and closes after terminal delivery. Reconnect with `Last-Event-ID`; on a browser-managed reconnect that advancing header supersedes the initial `after` query, so the acknowledged cursor is never replayed. Cursors are canonical decimal sequences and a cursor beyond the current ledger is rejected. Public events contain concise claims, actions, observations, and policy results. They authenticate their hash-chain continuity only; Provider progress and hidden reasoning are never forwarded.

Other read surfaces:

- `GET /v1/trust` — versioned Ed25519 public verification keys; never private key material
- `GET /v1/cases/{caseId}` — exact canonical live status and cursor
- `GET /v1/cases/{caseId}/seal` — exact canonical seal receipt
- `GET /v1/cases/{caseId}/seal/envelope` — receipt DSSE envelope
- `GET /v1/cases/{caseId}/intent-contract` — canonical, digest-bound input contract required for deterministic replay
- `GET /v1/cases/{caseId}/record` — exact canonical Record after `SIGN`
- `GET /v1/cases/{caseId}/record/envelope` — Record DSSE envelope
- `GET /v1/cases/{caseId}/terminal` — exact canonical terminal receipt after closure
- `GET /v1/cases/{caseId}/terminal/envelope` — terminal-receipt DSSE envelope
- `GET /v1/cases/{caseId}/artifacts` — canonical exported artifact index
- `GET /v1/cases/{caseId}/artifacts/{artifactId}` — indexed artifact bytes and identity headers
- `GET /v1/capabilities` — enabled adapter cards and live probes
- `GET /openapi.json` — transport contract

The `/seal`, `/record`, and `/terminal` resources are canonical payloads, not proof of their own authenticity. Verify their separate DSSE envelopes against `/v1/trust`, require the exact expected payload media types and canonical-payload equality, and require all three to authenticate under the same trusted key. Every accepted trust key authorizes exactly the ordered Seal, Record, and terminal payload-type tuple; missing, reordered, duplicated, or extra entries are invalid. Bind the Record's case/run/policy/Genome/search/intent identities back to the signed Seal. Then require the terminal receipt to equal the final status projection and complete ledger and to name the canonical Record and `jevyr.artifacts/1` index digests. Its envelope payload type is `application/vnd.jevyr.terminal+json`; its exact fields are `protocol`, `caseId`, `caseDigest`, `runDigest`, `lifecycle`, `stage`, `stageStatus`, `lastSequence`, `eventHeadDigest`, `recordDigest`, `artifactIndexDigest`, and `closedAt`.

The replay contract is accepted only when its canonical digest equals the authenticated Seal's `intentContractDigest`. Use the TypeScript SDK's `authenticatedRecord` or Python SDK's `authenticated_record` for the narrower Seal-plus-Record boundary. Use `waitForAuthenticatedRecord` or `wait_for_authenticated_record` to consume and authenticate the complete closure and exact artifact index; this still reports persisted evidence as not replayed and does not fetch every indexed body. Artifact fetch additionally verifies Case and response identity, media type, byte length, and the complete body's SHA-256 digest. Structural parsing alone is never signature or artifact authentication. The contract includes the original Cast, so it is a sensitive local read surface; a remotely bound daemon requires an authenticated transport boundary.

## Restart boundary

The daemon acquires an exclusive lease on its resolved data directory before it opens memory or accepts requests. A second live daemon pointed at that directory fails fast. A same-host lease whose recorded process no longer exists is atomically quarantined and retired; unreadable, cross-host, or otherwise ambiguous leases fail closed for operator inspection. Graceful shutdown drains aborted cases, closes Temporal Deep, and releases only the lease token owned by that daemon instance.

HTTP listen and MCP serving await durable recovery. Startup discovers every stored nonterminal status, but never resumes it: model, Forge, assay, and memory stages may have side effects that cannot safely be inferred after a process boundary. When the verified ledger contains a valid locally signed Record, Jevyr appends one explicit recovery event, terminates the Case without rewriting that Record, and signs the resulting terminal closure. Otherwise, when the existing ledger is readable and valid, it appends an explicit restart-failure event, persists a signed emergency Record with `integrity: INVALID` and `judgment: NOT_APPLICABLE`, marks the Case invalid, and signs that exact closure. A missing, malformed, or unverifiable ledger cannot receive a synthetic “unavailable” Record head or a cryptographic terminal receipt; recovery fails closed instead.

## Genome startup selection

The daemon resolves one Genome before it constructs the Case repository. The default registry is `<data-dir>/genome-registry`; `JEVYR_GENOME_REGISTRY_DIR` selects another explicit root. With no active pointer, Jevyr binds the built-in `baseline-static` descriptor. With an active pointer, startup re-verifies the content-addressed Genome, proposal, lineage, promotion, and DSSE attestation using Ed25519 public keys from `JEVYR_GENOME_GOVERNANCE_TRUST_FILE`. Any broken link or untrusted signature stops startup.

The active pointer is read once. The selected Genome digest and a public, path-free governance selection descriptor enter the repository's sealed provenance for every Case accepted by that daemon instance. Changing the pointer cannot rewrite an active runtime; it takes effect only after restart. Startup is read-only and cannot stage or promote a Genome.

## MCP

`pnpm --filter @jevyr/daemon mcp` serves newline-delimited JSON-RPC over stdio. It exposes `jevyr_cast`, `jevyr_run`, `jevyr_status`, and `jevyr_record`. `jevyr_cast` returns the ordinary quick receipt and uses the daemon's startup-configured Minds. `jevyr_run` is an explicit compatibility path that keeps its originating tool call open and binds that MCP client's declared Sampling capability as the only Mind for one Case. It requires explicit `provider_scoped` or `full_case` privacy and cannot mutate the daemon's global Mind set or create a later continuation channel. MCP Sampling is deprecated as of MCP 2026-07-28; Jevyr negotiates only the compatible 2025-06-18 and 2025-11-25 revisions for this path.

Every caller-model request uses `includeContext: "none"`: the only prompt is Jevyr's bounded, Seal-derived public prompt, so the MCP host is not invited to append ambient conversations, other servers, roots, or workspace context. The stock diversity temperature is `0.8`; MCP clients retain discretion to alter or ignore that preference. The stock adapter's requested completion ceiling is 90,000 tokens for newly created runs. The exact wire value is `min(90000, sealed per-invocation output reservation)`, not a required output length or a provider guarantee. With the default untouched Case envelope, the first fair-share reservation is `ceil(131072 / 12) = 10923`; reaching the 90,000 ceiling therefore also requires a larger pre-Cast project `search.resources.maxOutputTokens` envelope. Returned data remains subject to the 1 MiB MCP/duplex frame boundary, the adapter's 2,000,000-byte raw-output ceiling, strict public JSON parsing, and Case-wide accounting.

## Runtime configuration

Rule Mind is always present and deterministic. Codex CLI, Codex app-server, Claude CLI, Ollama, LM Studio, and a generic OpenAI-compatible text endpoint are opt-in through the variables in [.env.example](./.env.example). A `local_only` Case never reaches a provider-network adapter even if that adapter is enabled.

After Seal, adapters receive synthetic `jevyr:sealed-subject:` locators instead of submitted filesystem or network locators. The only direct content view is a bounded whole-file text projection from the verified private CAS. For `provider_scoped`, that projection is withheld from provider-network and unrestricted adapters but remains available to local and loopback adapters. `full_case` permits the projection for configured adapters; `local_only` excludes remote adapters.

The Forge defaults to Docker with the verified captured reconstruction mounted read-only, a disposable writable overlay, no network, a read-only container root, dropped capabilities, resource limits, and no implicit image pull. Startup resolves the configured image reference exactly once and seals Docker's immutable `sha256:` image ID into effective policy. The frozen built-in boundary creates a container from only that ID, inspects the concrete container's image before starting candidate code, and attests the checked execution identity. If resolution is unavailable, Forge remains non-executing until daemon restart. Docker being absent therefore produces durable `not-executed` evidence and cannot yield a false `ACCEPT`. Trusted-host execution requires both `JEVYR_FORGE_MODE=trusted-host` and `JEVYR_ALLOW_TRUSTED_HOST=1`; it remains diagnostic and cannot mint verdict evidence.

Execution is configured before any Cast by setting `JEVYR_FORGE_PLAN_FILE` to a JSON file. The daemon reads and hashes it once at startup, so later edits cannot steer an already-running daemon:

```json
{
  "command": "pnpm",
  "args": ["test"],
  "sourceRoot": "../subject-repository",
  "timeoutMs": 120000
}
```

`sourceRoot` is resolved relative to the plan file for stable pre-Cast policy binding, but that mutable path is never used as Forge input. At execution the orchestrator replaces it with a fresh reconstruction of the subject manifests and blobs committed by `subjectMaterialCaptureDigest`. A subject-dependent plan is blocked if its bound material is declaration-only. Changed files admitted by the sealed resource and Forge limits are exported to the Case artifact store before the disposable overlay is removed; their digests are bound into the Forge observation and signed Record, and the complete final artifact inventory is bound by the terminal receipt.

Minds may also return a candidate blueprint containing finite UTF-8 files and an optional no-shell command proposal. The daemon binds the project-root `.jevyrignore` digest into effective policy; the runtime compiles the blueprint under that policy and the sealed physical limits, stores its canonical digest, and erases the raw proposal. If selected, it is reverified and materialized into a fresh root, with captured subjects reconstructed beneath `.jevyr-subjects`. Its command is metadata only and cannot replace or modify `JEVYR_FORGE_PLAN_FILE`.

Command success is always diagnostic by itself and can never produce `ACCEPT`. Bone evaluates only the finite oracle compiled into the sealed intent contract against typed Forge evidence. An exact command-exit oracle is associated automatically when its no-shell argv uniquely matches this plan; other typed plans may name a deterministic `obligationId`. Optional `sealedSubjectDigest`, `sealedTestSuite.suiteDigest`, and `requestedAssay.{definitionDigest,evaluatorDigest}` fields bind specialized evaluators, but the current runtime deliberately blocks them because it does not yet possess a Bone-owned immutable evaluator substrate. Unknown fields—including the obsolete `decisiveOnSuccess` switch—are rejected. Model confidence, model-written feasibility labels, free-form metadata, and an exit-zero label never trigger either verdict.

Before any `sandbox_execution` event can influence judgment, Bone commits the exact finite candidate population, then writes each canonical ToolObservation to the Case artifact store. Bone caps each observation at 2 MiB and the unique Case evidence set at 64 MiB. Crystallization reopens the population and observation bytes, verifies their hashes and all Case/candidate/assay/material/invocation/substrate/accounting bindings, reconstructs the closed archive, reruns the typed oracle, and refuses to sign when replay is incomplete or disagrees with public authority edges. New artifact bytes are refused as soon as status becomes terminal; after terminal receipt material exists, status is closed too. An exact retry of already committed content may return its existing content-addressed metadata but cannot change the signed inventory. Opaque adapters, trusted-host mode, and copied capability cards remain observations only.
