# Jevyr buildout and measured release evidence

This document separates implemented mechanisms, observed experiments, and remaining evidence for the earlier approved plan. Its seventeen measured gates do **not** certify the newer attached DS Judge product specification. The approved transcript remains a reference in [the archived plan](../.lavish/approved-plan-reference.md). Protocol names, existing `jevyr` commands, and `.jevyr` state directories retain compatibility; `jevyr` is also an installed CLI spelling.

## Implemented additions

- Fastify HTTP service, bounded multipart uploads, JSONL daemon framing, atomic drop bundles, and inbound A2A all use the same sealed Cast boundary. A2A task/context continuation is refused. The CLI now exposes an explicit `--seed` for transport-equivalent submissions.
- `watch CASE_ID --tui` renders a bounded Ink live observer. Quitting the observer leaves the sealed lifecycle running. Genome Lab exposes the startup-bound Genome and measured offspring governance history through a read-only API and Chamber view.
- The policy has a Rego/Wasm adjudication kernel with TypeScript parity checks. Reflex has structured audits for investigator correlation, independence, premature convergence, evaluator boundaries, assumptions, memory contamination, paired probes, and evidence-free terminal claims. Missing measurements remain identified as unmeasured.
- Tree-sitter indexes source symbols and imports with file digests. Browser Forge runs a sealed Playwright probe inside a startup-pinned image and captures observations, runtime script sources, coverage, served sources, screenshots, accessibility output, and a trace. Script attribution does not establish causation.
- Docker and Podman have explicit startup authority contracts. Secrets can be configured through broker references with scoped lookup. The uv bridge creates exact offline experiment plans, including script and optional lock digests, for execution through Forge.
- Juggler now has an additive quantity channel under a separate presealed allowance. Signed receipts retain the original baseline, carry no semantics, and enter the scheduler only after durable publication and a distinct admission event. Mass adds general work; Refraction adds unused presealed templates; Polarity challenges an existing hypothesis; Fission isolates additional lanes; Inertia lowers the physical-evidence continuation threshold for an observed failed candidate. Legacy checkpoint vouchers are disabled for new runs. See [the metabolic contract and limitations](metabolism.md).
- CI installs frozen pnpm/uv dependencies and runs types, builds, and tests. Optional default-branch dispatch signs the exact tested archive with Sigstore and verifies commit provenance. The archive includes `packages/core/policy`, where the Rego and Wasm files live.

## Evidence retained on this machine

The reproducible aggregation is [the final measured report](../artifacts/release-evidence.json): seventeen of seventeen earlier gates pass within their declared finite scopes. It checks each named protocol assertion against actual runner output, independently verifies supplied signed lifecycle exports, and recalculates the paired memory experiment from raw local artifacts. Its `releaseReady` refers to `releaseTarget: earlier-approved-plan-17-gate-set`; `fullDsJudgeSpecReady` remains false. The exact rerun command is retained in the report.

- [Protocol experiments](../artifacts/protocol-experiments-v2.json): 23 exact checks across nine groups passed. These execute actual CLI children, loopback HTTP/SSE, JSONL and MCP framing, atomic filesystem intake, A2A dispatch, adaptive nursery scheduling, source capture, and deterministic fault injection. Paired policy perturbations hold authoritative evidence and obligations fixed while varying public prose. The report records each test name, precise assertions, timestamps, source digest, output digest, and raw output.
- [Memory ancestry checks](../artifacts/protocol-memory-closure.json) and [contamination/privacy checks](../artifacts/protocol-memory-dominance.json): six exact checks passed against real memory reconciliation and SQLite state. They cover transitive ancestry, corruption, cross-project refusal, two-run admission, contamination dominance, and reviewed SELF abstraction.
- [Signed lifecycle collection](../artifacts/lifecycle-evidence.json): all imported Cases are checked offline against all three Ed25519 DSSE envelopes, their terminal ledgers, every indexed artifact body, and independent persisted-evidence replay. Eleven of thirteen retained development/compiled attempts verify with the current compiled runtime; two intermediate formal-checker attempts remain rejected by replay and are excluded from the final gate evidence. All six lifecycle Cases selected for the final aggregate verify. They include actual local Qwen/Mistral investigation, Docker-backed command ACCEPT/REJECT, browser ACCEPT/REJECT, and a checked mathematical contradiction. An internally valid signature chain uses the key declared in that proof; an independently obtained key may be pinned with `--trusted-key-id`.
- [Blind versus memory-first experiment](../artifacts/blind-memory-1788571934560/verified.json): sixteen actual model-generated code executions form eight complete, scorable pairs over four tasks and two local models. Both arms solved four pairs, with different solved sets. The blind arm complements the memory-first arm on this finite sample. This is not evidence of general superiority, guaranteed seed enforcement, or a causal diagnosis of anchoring. The local experiment is explicitly unsigned.
- [Original Rule-only corpus](../artifacts/corpus-rule-1788570973540-3eed5130/report.json): all fourteen Cases authenticated and replayed; thirteen expectations passed. The impossible encoder remained UNPROVEN against its unchanged REJECT expectation. That failed baseline is retained. All corpus Cases in this baseline used the explicit Rule adapter, including the actual repository-source subject.
- [Final Rule-only corpus](../artifacts/corpus-rule-1788572984345-9edc6f09/report.json): fourteen of fourteen expectations pass, with fourteen individually exported signed proofs independently verified again during aggregation. The impossible encoder reaches REJECT through an exact sealed-statement, finite-sequence counterexample certificate. Its original REJECT expectation was not weakened. All 348 frozen repository-source files retain their pre-run hashes. The other thirteen judgments remain UNPROVEN; corpus success means the explicit constitutional expectations passed, not that the Rule adapter learned to solve those research tasks.

Intermediate failed or INVALID runs remain in `artifacts`. Later successful experiments do not rewrite their Records. Broad unit-suite success is recorded separately from these finite protocol and model experiments.

The newer additive channel also has [five measured calibration reports](../artifacts/metabolic-calibration-packaged-1788576146103/report.json), each with 64 paired seeds at doses 0, 1, and 2, with two executions per condition. The [independent verifier](../artifacts/metabolic-calibration-packaged-1788576146103/independent-verification.json) re-executed 192 trusted Node/Python sources and checked 2,115 artifacts. Every kind preserved its baseline trace, produced the intended finite scheduler effect, kept a fixed formal-evidence kernel verdict unchanged, and passed its declared finite-fixture regression bound. Conservative 95% difference intervals are approximately [-0.05663, +0.05663], inside the predeclared 0.1 margin. An [adversarial check](../artifacts/metabolic-proof-tamper-1788576636488/adversarial-check.json) rejects a fabricated execution claim even after its artifact, reference, and report digests are recomputed. These unsigned local experiments do not establish general live-model efficacy or unseen-defect recall.

## Reproduce and inspect

Run the finite protocol measurements, including their exact check inventory:

```sh
node benchmarks/protocol-experiments.mjs --output artifacts/protocol-experiments-new.json
```

Use `--experiment seven-submission-surfaces` or another ID from that file for a targeted repetition. The harness refuses to count skipped, absent, differently named, or failed assertions as passed checks.

Run the full Rule corpus in its own state directory with a frozen ignored-aware repository source snapshot and individual signed offline exports:

```sh
node apps/cli/node_modules/tsx/dist/cli.mjs benchmarks/run-isolated-corpus.ts
```

Run Docker lifecycle experiments with exact command oracles or browser probes:

```sh
node apps/cli/node_modules/tsx/dist/cli.mjs scripts/lifecycle-proof.ts accept
node apps/cli/node_modules/tsx/dist/cli.mjs scripts/lifecycle-proof.ts reject
node apps/cli/node_modules/tsx/dist/cli.mjs scripts/lifecycle-proof.ts browser-accept
node apps/cli/node_modules/tsx/dist/cli.mjs scripts/lifecycle-proof.ts browser-reject
node apps/cli/node_modules/tsx/dist/cli.mjs scripts/lifecycle-proof.ts models
```

`models` uses the explicitly configured local Qwen/Mistral models in the script. The other modes use finite source fixtures and do not claim model-produced invention. Browser modes require the local `jevyr-browser:1` image built from `scripts/browser-forge`.

Run or independently inspect the paired model experiment:

```sh
node benchmarks/blind-memory.mjs
node benchmarks/verify-blind-memory.mjs artifacts/blind-memory-EXAMPLE/report.json
```

Inspect saved signed proofs without opening the daemon or rerunning an execution:

```sh
node apps/cli/node_modules/tsx/dist/cli.mjs benchmarks/collect-lifecycle.ts --report artifacts/lifecycle-EXAMPLE/report.json --output artifacts/lifecycle-evidence-new.json
```

Repeat `--report` for more Cases. These commands use the compiled packages from the exact latest `pnpm build`. For development-created proofs, place `--conditions=development` after the tsx CLI in both the producer and verifier. The formal checker binds its actual module bytes, so compiled JavaScript and TypeScript source have different identities; substituting one for the other must fail replay.

## Release boundary

The aggregate closes the earlier seventeen gates within their stated finite scopes. The newer DS Judge target is tracked separately in [the current specification gate matrix](ds-judge-gates.md). Additive quantities and finite-fixture calibration now have implementation and measured evidence; these results do not certify the complete product or generalize the measured regression bounds to untested models and workloads.

No GitHub CI run or Sigstore provenance has been emitted by this local work. The workflow and verification commands are implemented, but their remote execution remains unmeasured. Docker has live execution evidence here; Podman has contract verification, and a live Podman experiment remains a separate portability check. These distinctions must accompany any release claim.
