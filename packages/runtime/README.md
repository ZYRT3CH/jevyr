# `@jevyr/runtime`

Runtime boundaries for Jevyr:

- capability contracts for minds, tools, and one-shot peers;
- deterministic zero-credential Rule Mind;
- the [isolated Codex app-server agent](./CODEX_AGENT.md), Claude CLI, the [genuine Claude Agent SDK harness](./CLAUDE_AGENT_SDK.md), Ollama, LM Studio, generic text-endpoint, and [text/stdin executable adapters](./TEXT_STDIN.md); legacy Codex CLI inference fails closed;
- Docker-default or Podman OCI execution, trusted-host opt-in, and observe-only Forge modes;
- immutable subject-material capture, bounded mind projections, and fresh Forge reconstructions;
- authority-free candidate blueprint compilation and verified disposable materialization;
- sealed Node/Python candidate experiment sockets with a comparative-only, non-Intent authority class;
- fsync-backed append-only canonical `CaseEvent` ledgers with 1-based monotonic cursors and `sha256:` digest chains;
- one-way orchestration across the canonical Cast → Snapshot → Seal → Terminate lifecycle;
- distinct local Ed25519 signatures for Seal receipts, crystallized Records, and terminal receipts that close the exact ledger, status projection, selected Record, and artifact index.

`CaseRepository.publicTrustBundle()` exposes only the active key id, Ed25519 algorithm, and SPKI public PEM. Private signing bytes and filesystem paths stay inside the repository and are never returned by the daemon trust endpoint.

Adapters produce only public contributions. They cannot author a verdict, change a sealed submission, or expose provider reasoning events. Bone links support or refutation only when its finite typed evaluator matches a machine observation to an oracle already present in the sealed intent contract. Generic process success, model confidence, free-form metadata, and MCP output have zero proof authority; absent typed decisive evidence leaves judgment `UNPROVEN`.

All Mind calls share one monotonic sealed resource meter. The next call receives a fair share of remaining output-token permission per remaining invocation; unused permission returns to the Case, while an opaque failure burns that complete per-call share as an upper bound. Metered retries charge every transmitted prompt and may not begin when the next prompt would cross the remaining input permission. Per-call output overruns are rejected without erasing their actual resource charge. The adaptive nursery receives a proportional sub-envelope rather than the whole remainder. Subject to the immutable Case ceiling, the scheduler preserves one DIVERGE call and one later opportunity for RECOMBINE, CHALLENGE, and each configured REFLEX loop; low budgets emit explicit denials instead of implying that a starved stage thought or spoke.

Candidate ancestry is explicit on `CandidatePayload.parentIds`: omission means undisclosed, while `[]` declares a root. The validator rejects duplicate parents and direct self-parenting. The field is lineage telemetry, not evidence.

`@jevyr/protocol` is the only public vocabulary: canonical subjects use `{id, kind, locator}`, control is `CaseIntent.control`, stages and event kinds are lowercase, and Records use the four-axis `JevyrVerdict`. `@jevyr/core` owns sealing, chain hashing, deterministic policy compilation, Reflex validation, crystallization, and DSSE signing.

`compileExperimentCapability(frontier, intentContract)` derives the exact
candidate-facing experiment sockets. `candidateExperimentReadiness` checks a
compiled blueprint against those sockets. A socket without an exact Intent
obligation is executable only as comparative archive evidence; it cannot mint
support/refutation edges. Reflex may spend its one repeat on strict persisted
evidence replay, never on a model-authored evaluator.

The runtime is transport-neutral. `@jevyr/daemon` supplies exact protocol objects over HTTP long polling and browser-compatible SSE, plus artifacts and the minimal MCP façade.

For Podman, Forge queries the server's exact rootless boolean before container creation. Rootless execution explicitly maps the invoking host user to the chosen non-root container identity with `--userns keep-id:uid=U,gid=G`, allowing writes to the private host-owned disposable root. Rootful execution instead uses `--userns host`, the same non-root `--user`, and the existing disposable-directory ownership transfer. Missing or ambiguous server mode fails closed. Neither path changes original subject ownership or uses Podman's recursive volume ownership option. These choices follow [Podman's user namespace documentation](https://docs.podman.io/en/stable/markdown/podman-run.1.html#userns-mode) and [server inspection documentation](https://docs.podman.io/en/stable/markdown/podman-info.1.html). Contract tests cover argument construction; live Podman execution still requires a recorded run on a Podman-equipped host.

`CaseRepository.statuses()` and `nonterminalStatuses()` provide validated durable discovery for startup recovery. `JevyrOrchestrator.recoverInterruptedCases()` closes interrupted histories without rerunning them: a valid signed Record is followed by an explicit recovery/termination event and a separately signed terminal receipt; a run without one receives a signed INVALID/NOT_APPLICABLE emergency Record and terminal receipt only when its existing ledger is readable and valid. Missing, malformed, or unverifiable ledger authority fails closed rather than minting a synthetic head. `bindReadiness()` prevents new casts from racing that reconciliation. The daemon owns the corresponding data-directory lease and readiness lifecycle.

## Quarantined MCP clients

`QuarantinedStdioMcpAdapter` connects only to an explicitly configured executable and argument vector with `shell: false`. Its child receives the exact environment supplied in configuration; it never inherits the Jevyr process environment or credentials. Every discovery or invocation starts a fresh process, performs `initialize` → `notifications/initialized` → `tools/list`, and then either closes the transport or performs one allowlisted `tools/call` before closing it. This lifecycle-per-operation design deliberately gives up connection reuse and server session state for a smaller, auditable isolation boundary.

Discovered server tools are labeled `quarantined` and `observation-only`; discovery never expands the explicit tool allowlist. Input bytes, cumulative stdout and stderr bytes, list pages, tool count, wall time, and shutdown time are bounded. Response IDs must match the single outstanding request. Malformed messages, oversized output, and all server-to-client requests—including roots, sampling, and elicitation—fail the operation closed. Successful results use `ToolObservation.status = "observed"`, never `"succeeded"`, and carry `admissibleAsProof: false`: an MCP result cannot satisfy an obligation or author a verdict without a separate policy-owned assay.

This adapter is an authority quarantine, not an operating-system sandbox. The MCP child may execute arbitrary code and may have unrestricted network reach, so operators should point it at a separately sandboxed server when side effects matter.

## Sealed provenance

Every run identity binds three content-addressed inputs in addition to the Case:

- the concrete deterministic policy descriptor, including snapshot rules;
- the genome descriptor actually selected for the run;
- a `jevyr.search-envelope/1` descriptor containing the astronomical attempt safety guard, nursery rules, and every hard resource ceiling.

The repository persists those exact JSON descriptors under their SHA-256 digest and verifies them again when loaded through `CaseRepository.descriptor(digest)`. The seal receipt and final Record carry all three digests. Changing a descriptor therefore changes `runDigest` while the input-derived `caseDigest` remains stable.

The built-in `jevyr.genome/1` descriptor is deliberately named `baseline-static`: it records an immutable runtime contract and makes no claim that a learned or evolved genome exists. A real promoted genome must be supplied with its own factual descriptor and version; the repository never synthesizes one during Cast. The daemon resolves the registry's active pointer once at startup, verifies its complete immutable proposal/promotion/governance chain, and constructs the repository with that one selection. Pointer changes do not alter an existing daemon.

## Subject snapshots

The repository resolves every canonical subject kind before sealing:

- `text` hashes the submitted UTF-8 bytes.
- `file` opens a regular file without following a symbolic-link root, verifies that it stays stable while read, and hashes its bytes.
- `directory` hashes a sorted path-and-content manifest, excludes `.git`, `.jevyr`, and `node_modules`, refuses links, junctions, and special files, enforces file/byte ceilings, and rechecks files before sealing.
- local `git` requires the repository root, resolves the declared revision to its commit and tree object IDs, and binds a double-observed status, binary diff, HEAD, and content hashes for every untracked file. Dirty snapshots expose a content-derived suffix in `SubjectSnapshot.revision`.
- remote `git` seals an address-and-revision declaration without cloning or contacting the network.
- `url` is declaration-only by default. Programmatic callers must construct `CaseRepository` with `url.mode: "fetch"` and an exact origin allowlist before any HTTP request is possible; redirects are rechecked against that allowlist and response bytes are bounded.
- `artifact` uses the locator `caseId/artifactId`, reloads the stored metadata and blob, and re-verifies its size and SHA-256 digest before reuse.

Snapshot resolution never modifies a source. A supplied `sha256:` revision on file, text, or directory subjects acts as an expected-content assertion and aborts sealing on mismatch.

## Subject material seal

Snapshot metadata is not the runtime's material source. `CaseRepository.create()` captures available subject bytes into content-addressed manifests and blobs, computes an ordered `subjectMaterialCaptureDigest`, and persists the Case binding before `status.json` creates a scheduling boundary. Declaration-only subjects receive committed manifests with zero bytes rather than an invented empty source. The capture digest is required by the sealed Case and Seal receipt and is transitively bound by `caseDigest`.

`loadSubjectMaterialCapture()` recomputes the binding digest, matches it to Case/run/Seal identity and snapshot digests, then rehashes each manifest and blob. Startup discovery, text projection, Forge materialization, and Record signing use that verification path. Pre-capture stored Cases are rejected as downgrades.

`projectSubjectText()` is the only direct subject-content view intended for minds. It emits deterministic whole-file UTF-8 content under file/count/total limits, explicit omission records, and no original locator. The orchestrator replaces all post-Seal locators with synthetic identifiers. Provider-network and unrestricted minds receive no projection for a `provider_scoped` Case; local and loopback minds may receive it. `full_case` permits the bounded projection, while `local_only` excludes remote minds.

`materializeSubjectMaterials()` writes only verified blobs into a caller-supplied, newly created real directory, under synthetic ordinal roots. Forge receives that reconstruction rather than a mutable source path. A subject-dependent assay is blocked when any bound subject is declaration-only.

## Candidate blueprint quarantine

Model output may include a narrow `jevyr.candidate-blueprint/1` source object: one or more UTF-8 `{path, content}` files and an optional portable executable basename plus string arguments. Compilation rejects unknown fields, unsafe or colliding paths, ignored/reserved output, secret-like content, and sealed-limit overflow. The compiled object derives file digests, byte counts, `shell: false`, `authority: "proposal-only"`, the exact ignore-policy digest, and its own content digest. The raw model object is discarded after compilation; refusal leaves the candidate as an abstract hypothesis.

Only the selected candidate's verified compiled blueprint is materialized. It is written with exclusive creation into a fresh random directory, then fully reread and rehashed. Sealed subject material is mounted separately beneath `.jevyr-subjects`. The blueprint argv is never executed on its own: only the policy-owned Forge plan whose digest was bound at Seal has execution authority. Bone alone decides whether the resulting typed observation satisfies a pre-Seal oracle.
