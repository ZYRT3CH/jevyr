# Privacy, memory, Genome, and growth

## The three memory scopes

`CASE` memory belongs only to one digest-bound run. `PROJECT` memory belongs to a named local project. `SELF` is deliberately impoverished: it may retain abstract strategy, calibration, blind-spot, and behavior-descriptor material, but not source content, case prompts, project names, paths, repository identities, or reusable verdicts.

Every memory candidate is immutable. Evidence observations, derived Tribunal snapshots, admission decisions, influence records, and tombstones are separate durable rows. Purging a project also removes Self records whose declared lineage depends on that project.

Memory cannot enter `INTERPRET` or the first divergent wave. After independent lineages exist, admitted memory may seed a hypothesis, strategy, or calibration with a recorded weight no greater than `0.2`. It is never admissible evidence.

## Memory Tribunal evidence

During CRYSTALLIZE, the runtime constructs one deterministic memory candidate, stores its exact canonical `application/vnd.jevyr.memory+json` bytes, and emits a Bone-owned commitment before the Record prefix closes. MEMORY_TRIBUNAL stages only those same bytes after reopening the artifact and checking the signed Record/head binding; crash recovery repeats that check and can idempotently finish staging. It does not call the candidate `ADMIT`, invent a reproduction, or treat the origin run as independent confirmation.

Every automatic project candidate contains a closed `jevyr.memory-reproducibility/1` value. It binds the exact intent contract and captured subject material; policy, Genome, seed-independent Search profile, and Assay Frontier; and the four outcome axes, selected feasibility, feasibility multiset, and basis-code multiset. Candidate ids, evidence ids, prose, and the concrete run-derived seed are excluded. The candidate is an exact outcome descriptor, not a claim that a strategy generalizes.

After terminal closure, the same Case can supply observations only about older staged memories. The reconciler re-verifies both normal signed Records, Seals, complete event chains, separately signed terminal receipts, exact closed artifact indexes, and committed candidates under one trusted key; requires the same project, exact task/material, exact mechanism, later sealed/staged/crystallized chronology, and a distinct source `runDigest`; and writes public content-addressed comparison artifacts. For contamination it expands every source Record influence and the target's ancestry to a fixed point of at most 1,024 unique memories. Every member must hash to its stored candidate and independently re-derive an exact `ADMIT` from its durable observations, snapshot, and decision. Direct project edges must remain project-local; only an admitted, privacy-reviewed `SELF` abstraction may bridge projects. Missing, malformed, cyclic, over-limit, cross-project-incompatible, or unverifiable lineage makes the comparison an exclusion. Contamination passes only when the verified source closure is disjoint from the target memory plus its verified ancestry. Exact outcome equality then becomes `REPRODUCTION`. A different outcome under the exact task and mechanism becomes `COUNTEREXAMPLE`. Task or mechanism changes and contamination are diagnostic exclusions with no Tribunal authority—never semantic-similarity evidence.

A closed `jevyr.memory-evidence-observation/1` attributes an authoritative comparison to its source content `caseDigest`, source execution `runDigest`, and evidence artifact digest. Exact repeats intentionally share a case digest; two distinct non-origin run digests with distinct reproduction evidence are required. A passing attributed contamination review, no counterexample, and no unresolved contradiction remain mandatory. A `SELF` candidate additionally requires a passing attributed privacy review, locally traceable lineage, and the restricted identifier-free schema. Missing quorum yields `PENDING` without sealing the ledger. Observation insertion, snapshot derivation, and terminal `ADMIT`/`REJECT` persistence occur in one immediate transaction; retry succeeds only after exact re-derivation of any existing observation, snapshot, and decision. The daemon exposes memory read-only, so authenticated reconciliation retains the mutation capability.

Fingerprint-bound memory is filtered by the current intent-contract and subject-material-capture digests before its summary or content is mapped into a Mind request. Thus an admitted exact descriptor cannot leak into a merely similar task and be rationalized afterward through attribution.

## Privacy modes

- `local_only`: only adapters whose capability card declares no network or loopback transport may run. They receive synthetic subject descriptors and may receive the bounded text projection.
- `provider_scoped`: configured provider-network adapters may run, but they receive synthetic subject descriptors and no direct subject text projection. Local and loopback adapters may receive the projection.
- `full_case`: configured adapters may receive synthetic descriptors and the bounded text projection their role uses.

Original locators are replaced with `jevyr:sealed-subject:` identifiers before any mind invocation. The text projection is derived only from reverified captured bytes; it includes whole valid UTF-8 files under sealed bounds and records binary, excluded, declaration-only, or over-limit material as explicit omissions. Privacy is fixed by the Seal. An adapter disappearing is an observation, not permission to widen disclosure.

## Growth without live self-rewriting

An active phenotype never edits its Bone or replaces its own Genome. Growth happens by reproduction:

1. a parent Genome creates an immutable descendant;
2. the descendant runs in quarantine against invariant, historical, held-out, contamination, and resource suites;
3. it undergoes corruption, resource-loss, adversarial-input, and tool-loss damage trials;
4. it must show novelty and material gain without held-out regression;
5. the proposal is staged, never self-promoted;
6. a separate governance key may sign promotion for a later Case.

Promotion becomes selectable only through the registry's active pointer. At daemon startup, Jevyr reads that pointer once and verifies the immutable Genome, proposal, lineage, promotion, and DSSE attestation against configured Ed25519 public keys. With no active pointer it binds the explicit baseline descriptor. That selection and the public trust-key fingerprints are sealed into provenance for every Case handled by the daemon instance. Pointer edits do not alter a live runtime, and daemon startup has no staging or promotion path.

`packages/growth` contains the operational, fail-closed compiler used for governance-promoted Genomes. It accepts only three versioned built-in module descriptors whose artifact digests, permissions, purposes, and exact parameter schemas are compiled into Bone:

- `jevyr.nursery-governor`: `saturationWindow` and `challengeInterval`;
- `jevyr.archive-curator`: archive `capacity` and `minimumNovelty`;
- `jevyr.late-memory-gate`: `recallLimit` and `weight`, with weight capped at `0.2`.

Compilation binds the stored Genome to Jevyr's independently owned Bone digest and returns inert numeric knobs plus a profile digest. Unknown or duplicate modules, code/package references, mismatched versions or permissions, absent/extra parameters, inherited or accessor-backed input, non-finite numbers, and out-of-range combinations fail startup closed. No registry artifact is imported or executed.

For an active promoted Genome, omitted modules resolve to the compiler's conservative profile defaults rather than silently inheriting project behavior: nursery saturation/challenge `64/8`, archive capacity/novelty `64/0.1`, and late-memory count/weight `0/0`. The directional composition below may tighten those values further. This active-Genome baseline is intentionally distinct from starting the daemon with no active pointer.

The daemon composes those knobs so Genome can only remove permission:

- project policy retains all physical resources, the attempt ceiling, minimum attempts, independent lineages, and seed derivation;
- saturation is `min(project, Genome)`, and challenge cadence is the minimum of project, Genome, and effective saturation;
- measured archive capacity is `min(4096, Genome)`, while its novelty floor is `max(0, Genome)`;
- active recall count is `min(12, Genome)`, and memory weight is `min(project maximumLateInfluence, Genome)`.

With no promoted Genome, baseline behavior remains project nursery settings, archive capacity `4096`, archive novelty `0`, recall limit `12`, and project-capped weight up to `0.2`. Zero recall or zero weight prevents any memory hint from entering recombination. For a nonzero hint, the cap governs its recorded attribution; it cannot quantify or control how strongly a stochastic model attends to text it can see.

The compiled profile and composed growth-policy digests are sealed into effective policy. Nursery controls enter the sealed search profile, archive controls enter the sealed Assay Frontier, and recall controls are checked against that same policy at orchestration. Genome still cannot change Forge/network/privacy/reflex authority, expand a physical budget, rewrite Bone, or affect a running daemon after startup.

The search horizon is not an intelligence score. A sealed profile contains a physical effort ceiling, independent-lineage floor, minimum exploration, novelty threshold, saturation window, ecological challenge cadence, and a last-resort attempt safety ceiling. Jevyr reports attempts as telemetry. The default `1500000000000000000000` (1.5 × 10²¹) ceiling is only a remote runaway-loop guard; physical resources and saturation stop useful work long before it. Making the guard larger does not manufacture insight.

Quality diversity is tracked separately across semantic, mechanism, causal, and implementation descriptors. A Pareto archive preserves distinct viable niches, while invalidated or unsupported candidates remain visible as Scars in the graveyard.
