# Assay Frontier v1

The Assay Frontier is the finite, policy-owned experiment set Jevyr closes before Cast. It replaces post-selection experiment choice. A Mind may propose a finite candidate blueprint, but it cannot add an assay, change an oracle, select a winner, or enlarge a resource limit.

## Sealed descriptor

`jevyr.assay-frontier/1` contains:

- a bounded list of uniquely named assays, canonicalized in ordinal `assayId` order;
- exact no-shell command arguments, an optional sealed obligation id, and typed-oracle bindings;
- a positive deterministic `costUnits` charge for each execution;
- the complete case-wide Forge wall/CPU, assay-cost, writable-byte, writable-inode, and artifact-byte ceilings copied from the sealed search envelope;
- the compiler-owned quality-diversity archive configuration, including any Genome-tightened capacity and novelty floor; and
- a SHA-256 digest over the complete descriptor except the digest field.

Operators provide only `{ "protocol": "jevyr.assay-frontier/1", "assays": [...] }`. `jevyr init` writes the empty canonical form to `.jevyr/assay-frontier.json`, and the daemon discovers that exact repository-local path when neither environment override is set. `JEVYR_ASSAY_FRONTIER_FILE` selects an explicit alternative. Each assay has `assayId`, positive integer `costUnits`, `tool: "forge.command"`, and `args: { "command": "...", "args": [...] }`, plus optional timeout and typed obligation bindings. Aggregate limits and archive policy are compiler-owned outputs, not caller-controlled fields. V1 fixes `5` bins per dimension and `2` elites per niche. Baseline archive capacity is `4096` with novelty floor `0`; a governance-promoted Genome may only lower capacity or raise novelty, and those effective values enter the frontier digest. Relative paths resolve from the explicit project root; the loader requires a stable regular non-symlink file and rejects unknown data.

V1 deliberately rejects `sourceRoot` and `environment` in assay arguments. Bone supplies a new candidate root, while environment values would expose secret material through the public policy descriptor. `JEVYR_FORGE_PLAN_FILE` supports the old single-plan shape only as a strict loader bridge: when set, it suppresses conventional-file discovery and becomes one `legacy.default` frontier entry before the repository and Cast exist. Configuring both environment variables is an error.

## Execution and judgment

During DIVERGE, candidate JSON is immediately compiled into an authority-free, bounded blueprint. The population closes after DIVERGE as an exact content-addressed `jevyr.candidate-population/1` artifact before any cell can run. During EMBODY, Bone traverses the canonical candidate × assay product. It checks the frontier digest, typed obligation binding, authenticated Docker boundary, and remaining aggregate resources before creating a directory. Every executable cell receives a separately reconstructed candidate tree and sealed-subject mount, and that tree is removed after the call. A refused cell records its reason and zero charge without execution.

Forge timestamps do not control the wall budget; Bone charges its own monotonic elapsed time and rejects a result settling at or beyond the cell deadline even when an adapter blocked the JavaScript event loop. Complete `jevyr.forge-resource-accounting/1` workspace readings are required for archive admission. CPU is accumulated and enforced when the built-in boundary supplies a measured value; otherwise it remains explicitly declaration-only. Each persisted observation carries Bone-owned per-cell and aggregate-after accounting. CAS storage is charged by newly stored digest, while candidate ranking uses invocation-bound output bytes so deduplication cannot make a later candidate appear cheaper.

During ASSAY, each raw candidate observation and typed evaluation is emitted without global support/refutation edges. The archive is closed before any `survived` event is emitted, so a provisionally admitted candidate displaced later cannot remain a replay survivor. Only candidates with a complete, decisive, admissible, executed, passing assay set may survive. The flagship is selected deterministically from those measured survivors. Only then does Bone emit winner-scoped critical evidence against the sealed obligations.

If the frontier or a plan is unbound, accounting is incomplete, or no candidate is measurable, Jevyr records blocked/invalidation events and selects nobody. Exhausting any aggregate resource truncates the frontier, invalidates every candidate's completeness, and also selects nobody—even when an earlier cell passed. A successful process label, candidate id, ordering, confidence, or persuasive prose can never substitute for typed measured evidence.

The default attempt safety ceiling, `1500000000000000000000` (1.5 × 10²¹), is unrelated to frontier size and does not authorize that much work. It is a final runaway-loop guard behind the sealed physical budgets, saturation, and the hard v1 limit of 256 assays.

## Deliberate declaration-only limits

The v1 runtime still does not end-to-end meter network bytes or execute multiple lineages concurrently. Nursery `challengeInterval` is now an operational deterministic cadence and may be tightened by an active Genome. `maxForgeCpuMillis` remains declaration-only for the built-in Forge because its Docker setting limits rate, not total consumed CPU. Opaque and trusted-host adapter measurements are diagnostic only and cannot enter the measured archive.
