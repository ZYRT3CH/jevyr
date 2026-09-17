# Jevyr architecture

## The object being built

Jevyr is not a chat agent and not an approval bot. It is a bounded experimental ecosystem with one semantic inlet and a public, one-way outlet. Every valid case must both create and judge, even when the impulse is sparse, the subject is broken, or the requested object is impossible.

```text
one impulse + frozen subjects
            │
         AIRLOCK  ─────── semantic input ends
            │
   sealed case + signed receipt
            │
  ┌─────────┴─────────────────────────────────┐
  │ independent minds     quarantined peers   │  create claims/candidates/tests
  │ late Archivist        Assay Frontier cells│  retrieve hints/observe effects
  └─────────┬─────────────────────────────────┘
            │ immutable public evidence graph (Blood)
            │
     deterministic kernel (Bone)              compiles, never negotiates
            │
   reflex → Record signature → later stages → termination
                                            │
                              terminal receipt signature
```

There is no route from observation back to semantic control. Network retries, opaque Juggler effort vouchers, cancellation by the host, and infrastructure shutdown are control-plane actions; none may add a goal, target, preference, or verdict instruction.

## Lifecycle

The full state machine is:

`CAST → SNAPSHOT → SEAL → SELF_SCAN → INTERPRET → DIVERGE → RECOMBINE → EMBODY → CHALLENGE → ASSAY → REFLEX → CRYSTALLIZE → SIGN → MEMORY_TRIBUNAL → TERMINATE`

The order is constitutional. In particular:

1. `SNAPSHOT` resolves every subject, captures available bytes into a private content-addressed store, and records declaration-only subjects without inventing material.
2. `SEAL` normalizes the impulse, policy, Genome, seed, subject snapshots, and subject-material capture digest into a signed receipt.
3. `INTERPRET` keeps incompatible readings alive without asking for clarification.
4. `DIVERGE` grows mechanism-diverse candidates. The first wave is amnesic.
5. `RECOMBINE` may introduce low-weight admitted memory after the population is already independent. It does not select a flagship.
6. `EMBODY` traverses the finite candidate × assay product. Each executable cell reconstructs the candidate and verified subject bytes into its own disposable root and runs only its pre-sealed policy plan; a blocked cell records why no root or process was authorized. A candidate command is never execution authority.
7. `CHALLENGE` publishes attacks and discriminating tests without changing the closed candidate population or assay set.
8. `ASSAY` first publishes candidate-scoped observations as nonadjudicative comparative evidence. Bone closes the measured quality-diversity archive, selects a flagship only from its survivors, then emits winner-scoped critical evidence and compiles four independent outcome axes.
9. `REFLEX` challenges coverage, leakage, and evaluator gaming. One second loop is permitted only for material evidence work; the hard cap is two.
10. `CRYSTALLIZE` freezes the evidence graph and verdict into a Record whose head is this verified prefix.
11. `MEMORY_TRIBUNAL` stages the exact quarantined candidate committed in the signed Record prefix. It does not admit that candidate or let the origin run testify for itself.
12. `TERMINATE` closes the Case, authenticates its signed Record and complete ledger, and uses it only as a later observation of older staged memories whose project, task/material, mechanism, chronology, and contamination bindings verify exactly. Reconciliation is public and idempotent; the final stage event closes the transport head. Bone then separately signs a terminal receipt that binds that exact head and status projection, the canonical Record digest, and the complete canonical artifact-index digest.

## Anatomy and authority

| Name      | Concrete role                                                    | Authority                                                                                                                           |
| --------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Bone      | Constitution, validators, lifecycle, deterministic policy kernel | May reject malformed state and compile verdicts                                                                                     |
| Genome    | Versioned strategy descriptors and bounded built-in parameters   | May tighten later-Case search, retention, and recall; cannot expand authority, alter an active case, or load arbitrary code         |
| Phenotype | One seeded execution of one genome                               | May create public contributions; no verdict authority                                                                               |
| Brood     | Blind independent lineages                                       | May disagree and compete; no shared first-wave anchor                                                                               |
| Forge     | Disposable overlay and tool boundary                             | Executes only authorized candidate × assay cells over fresh reconstructions; may produce observations and artifacts, but no verdict |
| Blood     | Append-only claims, actions, evidence, scars, and digest links   | Carries auditable facts; append-only within a case                                                                                  |
| Deep      | Temporal project memory and abstract cross-project Self Archive  | Supplies late, low-weight hypothesis seeds; never evidence                                                                          |
| Scar      | Durable invalidation or failed lineage                           | Prevents erased failures and repeated self-deception                                                                                |
| Record    | Signed crystallization output                                    | Immutable summary of evidence, reflex, memory influence, and verdict; binds its earlier verified ledger prefix                       |
| Terminal receipt | Separately signed closure                                 | Authenticates the exact final ledger and status projection, canonical Record digest, and complete artifact-index digest              |

Inner minds are coequal and commit before they see siblings. Dynamically discovered tools, MCP servers, and A2A peers are quarantined witnesses. Capability does not confer authority; model size does not change evidence weight.

Mind work is metered against one monotonic Case-wide envelope. Before each call, Bone grants a deterministic ceiling equal to the remaining output tokens divided across the remaining invocation slots, rounded up. A successful call is charged its actual receipt and permission it did not use remains available; an opaque failure is conservatively charged the call's complete reservation, never every token reserved for later calls. Provider retries repeat the exact same output ceiling, charge every transmitted prompt, and are refused before transport when another prompt cannot fit the remaining input permission. A provider that crosses its per-call ceiling cannot contribute, but its actual usage remains charged. DIVERGE receives only a proportional sub-envelope: Bone preserves one invention call where physically possible, then reserves one real contribution opportunity for RECOMBINE, CHALLENGE, and every configured REFLEX loop. With too few sealed calls, earlier commentary is visibly denied so invention and the final Reflex opportunity survive; no resource is copied or added.

Candidates may contain a finite `jevyr.candidate-blueprint/1`: UTF-8 files and an optional no-shell argv proposal. Bone immediately reduces that untrusted object under the sealed `.jevyrignore` digest and physical write limits. The effective policy embeds the exact bounded ignore-file source as well as its digest; persisted-evidence replay recompiles those bytes and independently revalidates every population blueprint against the reconstructed rules. Unknown fields, unsafe paths, secret-like content, collisions, and attempts to smuggle an oracle, verdict, environment, working directory, timeout, shell, or authority are refused. A refused blueprint leaves its candidate visible as an abstract hypothesis. Every admitted blueprint is content-addressed, reverified, and separately materialized for each executable pre-sealed assay; its command remains inert even when it happens to match an assay plan.

Candidate ancestry is public data rather than an inferred resemblance. `parentIds` omitted means ancestry was not disclosed; `parentIds: []` explicitly declares a root. Nursery descendants publish their parents, and later selected or embodied states retain the candidate identity. Genealogy does not grant evidentiary or verdict authority.

An external witness has two locks: the server configuration and exact call are fixed before Cast, and the public descriptor digest is included in policy provenance. Runtime discovery may confirm that an allowlisted tool exists, but it can never add a call. Witness output may perturb later hypothesis generation; it remains untrusted data, is shown as such in Blood, and cannot create a support or refutation edge.

## Material boundary

The signed Seal commits to `subjectMaterialCaptureDigest`, a digest over the ordered subject bindings. Materialized subjects bind content-addressed manifests and blobs; remote Git and default URL subjects remain explicit declaration-only entries. The per-Case binding is durable before the Case becomes schedulable. Loading a runnable Case, projecting text, reconstructing Forge input, and signing a Record re-establish the binding against the Seal and rehash referenced material. Mutation or a missing legacy binding fails closed.

Minds never receive original locators after Seal. All receive synthetic `jevyr:sealed-subject:` descriptors. The only direct content view for a mind is a deterministic, bounded text projection read from verified captured bytes: files are included whole or reported as omissions, never silently truncated. In `provider_scoped`, provider-network and unrestricted adapters receive no direct subject text projection; local and loopback adapters may receive it. In `full_case`, configured minds may receive the bounded projection. In `local_only`, provider-network minds are excluded.

Forge likewise does not reread a submitted path. For every candidate × assay cell, the candidate files occupy a newly created disposable root and sealed subjects are reconstructed separately beneath `.jevyr-subjects`. Bone supplies that root to the sealed plan; neither the Assay Frontier file nor a candidate may select a source root. The candidate worktree and Forge-owned home, temporary, cache, and shared-memory directories live inside one polled and completely post-scanned writable envelope. Runtime files consume physical budget but remain separate from candidate-output diffs and artifact export. A declaration-only subject blocks a subject-dependent assay instead of being treated as empty or successful.

The complete finite `jevyr.assay-frontier/1` is canonicalized and digested before Cast. Its aggregate wall, CPU, assay-cost, writable-byte, writable-inode, and artifact-byte limits come from the same sealed Case resource envelope. Bone derives a narrow [experiment capability](experiment-capability.md) so a Mind can build the exact candidate entry file expected by a sealed plan without receiving oracle authority. Before the first cell, Bone persists one canonical `jevyr.candidate-population/1` closure containing every admitted candidate and blueprint commitment. Raw cell observations carry candidate and assay identity but no global support/refutation edge. Only after the archive closes can Bone select a survivor and emit adjudicative evidence for that selected candidate. A comparative-only experiment may shape that archive but can never emit an Intent edge. If resource exhaustion truncates any part of the frontier, every candidate is ineligible and nobody is selected. See [Assay Frontier v1](assay-frontier-v1.md).

Every sandbox observation that can affect judgment is first encoded as exact canonical `jevyr.tool-observation/1` bytes and stored in the Case content-addressed artifact store. The public evidence event names that byte digest; it is never allowed to point only at an in-memory object. The built-in Docker Forge snapshots and freezes its configuration and startup identity, creates without starting, inspects the concrete container's image ID, and starts it only when that ID equals the policy seal. Opaque adapters, observe-only mode, and trusted-host mode may produce diagnostic observations but cannot mint verdict edges. Before crystallization, Bone reopens the population and observation artifacts, rechecks their hashes and Case/candidate/assay/invocation/material/substrate bindings, reconstructs the complete matrix and archive, reruns the typed oracle, and compares the result with every support or refutation edge. Missing, corrupt, conflicting, or irrelevant evidence is non-adjudicative and prevents Record crystallization. The evidence store has a Bone-owned 2 MiB per-observation and 64 MiB per-Case envelope distinct from candidate artifact allowance.

## Genome boundary

The daemon chooses one Genome before constructing its Case repository. It reads the registry's active pointer once and accepts it only after the content-addressed Genome, growth proposal, promotion, lineage, and governance signature verify against configured Ed25519 public keys. With no active pointer it binds the explicit `baseline-static` descriptor. The verified selection and public governance-key fingerprints enter sealed policy provenance. Every Case accepted by that daemon instance therefore shares the same immutable selection; a later pointer change is visible only after restart. Startup never stages or promotes a descendant.

Daemon startup compiles a governance-promoted Genome against a runtime-owned Bone digest before it creates the Case repository. The executable catalog is closed to three built-ins: nursery saturation/challenge cadence, measured archive capacity/novelty, and late-memory recall/weight. It rejects unknown modules, versions, artifact digests, permissions, fields, accessors, inherited configuration, and out-of-range parameters, and never imports a Genome artifact as code.

Composition is directional. Project policy keeps every physical resource, attempt ceiling, minimum-attempt floor, lineage count, and seed rule. An active Genome may only take the minimum saturation window; the minimum project/Genome/effective-saturation challenge interval; the minimum of Bone's `4096` archive cap and the Genome cap; the maximum of Bone's `0` novelty floor and the Genome floor; the minimum of Bone's `12`-item recall cap and the Genome count; and the minimum of the project `0.2` ceiling and Genome memory weight. No active pointer preserves the built-in behavior of 12 recalled items at no more than `0.2`. Zero recall or weight prevents exposure. A nonzero weight caps the recorded attribution, not the model's unknowable degree of attention to visible text.

The compiled profile digest and composed `jevyr.runtime-growth-policy/1` digest are included in effective policy. The effective nursery profile is sealed into the Case, archive controls into the Assay Frontier, and memory controls into the orchestrator. A pointer change still cannot affect a running daemon or active Case.

## Temporal Deep reconciliation

An automatically staged project memory is an exact outcome descriptor, not a generalized strategy. Its closed reproducibility fingerprint commits the intent-contract and subject-material-capture digests; policy, Genome, seed-independent Search profile, and Assay Frontier identities; and an outcome signature containing the four axes, selected feasibility, feasibility multiset, and basis-code multiset. Per-run seeds, candidate ids, prose, and evidence ids are deliberately absent.

After a Case has a verified normal Record and signed terminal ledger closure, it may be compared with older staged descriptors in the same project. Equal Case content may—and for an exact repeat normally will—have the same `caseDigest`; independence is proven by distinct signed `runDigest` values and distinct committed memories. All source chronology points must be later than the target staging instant. Contamination is not a direct-reference check: Temporal Deep closes the source Record influences and target ancestry transitively, with the target itself included on the target side. Each of at most 1,024 unique ancestors must pass candidate hashing and an independent replay of its durable observation snapshot and `ADMIT` decision. Missing, malformed, cyclic, over-limit, incompatible, or unverifiable lineage is excluded; verified closure intersection fails contamination. A fully exact clean result creates a reproduction observation; an exact task/material/mechanism with a different outcome creates a counterexample. Task or mechanism changes, including apparently similar prose, produce only public exclusion diagnostics and no Tribunal edge.

Observation batches, derived snapshots, and terminal decisions commit atomically. Stable ids make restart recovery idempotent, but an existing terminal decision is accepted on retry only after the durable observations, snapshot, and decision are independently re-derived. Two distinct later source runs remain mandatory. Fingerprinted memory is filtered against the current intent/material digests before its summary or content can enter a Mind.

## Creation and judgment

Audit and design are not separate products:

- In audit mode, Jevyr creates hypotheses, attacks, tests, counterexamples, and repairs before judging the target.
- In design mode, Jevyr creates mutually distinct mechanisms, tries to embody them, attacks them, and judges the survivor.
- With a sparse impulse, Jevyr generates multiple plausible interpretations and judges what can be established without clarification.
- With an impossible impulse, Jevyr preserves and judges the original request, while it may separately create the nearest viable construction.

The creation objective is **productive estrangement**: the strangest defensible mechanism, not unusual wording. The hypothesis nursery and measured assay archive are distinct. Exact-content novelty admits untested hypotheses to the nursery; only typed, executed, resource-accounted assay results can enter the semantic, mechanism, causal, and implementation archive. A flagship exists only when that archive has a survivor; failures and displaced candidates remain visible as scars.

### Search has physics, not a magic idea count

Jevyr never treats attempt count as intelligence. Each Case seals a physical effort envelope and a discovery policy: an independent-lineage floor, minimum exploration, novelty threshold, niche coverage target, saturation window, challenge cadence, and a last-resort attempt safety ceiling. Search continues while admissible novelty and useful challenge are still arriving. It terminates on measured saturation or exhausted effort. The default ceiling, `1500000000000000000000` (1.5 × 10²¹), is only a remote loop guard, and the wire representation is capped at 128 decimal digits. Every evaluated attempt consumes at least one integral effort unit, so numeric underflow cannot turn that guard into an infinite loop. Raising it cannot create compute, evidence, or depth.

Candidate count, effort consumed, niche growth, novelty yield, challenge yield, and the exact termination reason are public telemetry. A worker that exceeds its authorized effort cannot place a candidate in the archive.

## Outcome lattice

One scalar score is forbidden. The kernel emits independent axes:

- integrity: `VALID | INVALID`
- creation: `CONCEIVED | NO_SURVIVOR | FAILED`
- embodiment: `BUILT | NOT_BUILT | FAILED`
- judgment: `ACCEPT | REJECT | UNPROVEN | NOT_APPLICABLE`
- candidate feasibility: `BUILDABLE_NOW | BRIDGEABLE | LAWFUL_BUT_OPEN | CONTRADICTED`

`NOT_APPLICABLE` is legal only when integrity failed before judgment. A critical proposal that was not executed is `UNPROVEN`, even when every model calls it excellent.

## Live projection

The scheduler appends each public stage transition, claim, action, observation, candidate state, assay, reflex finding, and kernel operation to Blood. The HTTP daemon exposes the same monotonic trace through SSE and cursor-based long polling. The Chamber, CLI, and SDKs are projections of that trace; they do not maintain a second truth.

Public trace means inspectable claims and observations, not hidden chain-of-thought. A reconnect proves continuity through exact event shape, sequence, case/run identity, prior digest, event digest, and forward-only lifecycle progression. The signed Record binds the verified prefix used at crystallization. `SIGN`, `MEMORY_TRIBUNAL`, and `TERMINATE` then extend that same chain, so the terminal transport head is later by design; clients verify that the Record head occurs in the continuous ledger rather than falsely equating the two. A terminal event is not closure proof. The separately signed terminal receipt binds the exact final sequence and head, final status projection, canonical Record digest, and digest of the complete canonical artifact index under the same trusted key as the Seal and Record.

Artifact retrieval is itself a verification boundary. New artifact bytes are refused after terminal status, and the terminal receipt authenticates the exact closed canonical index; an exact content-addressed retry may only retrieve metadata for bytes that were already committed. Both SDKs validate the artifact index and Case binding, then require response identity, media type, byte count, and a locally recomputed SHA-256 digest to agree before returning verified bytes. A successful HTTP response is not artifact authenticity.

Trust scopes remain separate in client output. A live frame proves only `event-hash-chain`; an authenticated Record proves `dsse-signature+seal-provenance` and explicitly says `persistedEvidence: not-replayed`; the authenticated terminal wait adds `event-hash-chain+signed-terminal-head`, including exact status-projection, Record, and artifact-index bindings. Only complete replay may combine those bindings with the exact policy, IntentContract, and persisted artifact bytes and report independent validity. The signed `verdict.integrity` value is otherwise an authenticated recorded claim, not a client-side evidence finding.

## Implementation map

```text
packages/protocol  canonical wire types, schemas, normalization, digests
packages/core      seal, ledger, evidence graph, policy, reflex, replay, signing
packages/runtime   minds, peer/tool boundaries, Forge, orchestration
packages/sdk       browser/Node TypeScript client with SSE→poll recovery
sdk/python         standard-library Python client with the same recovery contract
apps/daemon        loopback HTTP/SSE and MCP boundary
apps/cli           airlock, live watch, replay, compare, benchmarks, MCP serve
apps/chamber       human live projection
benchmarks         constitutional and adversarial corpus
.github            exact-SHA advisory workflow
```

The first release can speak to Codex, Claude, Ollama, LM Studio, generic OpenAI-compatible text endpoints, MCP tools, and one-shot A2A peers through adapters. Missing credentials or an unavailable sandbox are observations that constrain the verdict; they are never silently treated as success.
