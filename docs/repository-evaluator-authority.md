# Original-repository evaluator authority

Status on 2026-09-05: the closed pure assertion evaluator, fixed OCI producer, authenticated certificate replay, and explicit Bone v2 integration are implemented. The first installed daemon/HTTP lifecycles produced ACCEPT, REJECT and UNPROVEN as declared. All three retained exports also [replay under the final standalone application](../artifacts/app-release-historical-replay-1788609961005/report.json), with exact original Record digests and signer pins in fresh Node processes outside the checkout. The later production-launch and investigator-prompt changes preserve the required producer, kernel and certificate-checker identities. The distinct source and historical installed measurements remain recorded below.

The existing repository test observer remains diagnostic. Its Node runner counts, test messages and reported failures cannot support or refute an obligation. Original-source authority comes through a separate, independently reconstructed certificate, not by changing the observer's label.

## Exact purpose and verdict scope

[Core's original-subject kernel](../packages/core/src/original-subject.ts) requires the complete, authenticated original Case to contain exactly the impulse `Existing tests must pass.`, one captured directory subject, one recompiled critical obligation, and no additional constraints or requested assays. The exact intent contract, subject identity, capture digest and current kernel identity must agree. Broader requests, qualified requirements, multiple subjects and mixed creation/evaluation requests do not acquire this authority.

Activation is explicit: project `policyVersion: "bone-v2"` selects `jevyr.bone/2` and the separately pinned [Bone v2 descriptor](../packages/core/src/bone.ts). Embedded daemon/core defaults and original Bone v1 exports remain v1; [fresh CLI initialization](new-projects.md) writes an explicit v2 project policy while preserving existing files. Existing [v1 Rego](../packages/core/policy/judgment.rego) and Wasm bytes are preserved; [v2 Rego](../packages/core/policy/judgment-v2.rego) and Wasm are distinct installed resources. Historical custom policy labels retain their legacy behavior and cannot authorize original-subject edges.

For this exact original purpose:

- Complete matching original assertions can produce ACCEPT without a generated candidate. Creation and embodiment remain their actual values, including `FAILED / NOT_BUILT` when no candidate exists.
- A complete original assertion mismatch can produce REJECT.
- Candidate sandbox edges, candidate assays, exhausted candidate populations and candidate feasibility contradictions do not adjudicate the unchanged-original obligation. They remain candidate assessments and can affect the creation/embodiment axes.
- Duplicate selections retain a coherence finding and prevent ACCEPT, without themselves refuting the original source. Global integrity faults, material investigation audits and critical assays without candidate scope retain their existing effects.
- An authenticated purpose with no original evidence remains UNPROVEN even if generated candidates pass or fail. Purpose is derived before evidence exists; omitting an original evaluator action cannot restore candidate authority.

[TypeScript policy](../packages/core/src/policy.ts), the v2 Wasm module and [Reflex](../packages/core/src/reflex.ts) implement that same scope. The [core regressions](../packages/core/test/original-subject.test.ts) cover clean original/defective candidate, defective original/passing candidate, unavailable original evidence, global guards, contradictory original evidence and integrity phases. Direct Wasm tests pass unfiltered candidate assay rows to ensure the scope rule is enforced inside the module.

## Closed language, discovery and capture

The [analyzer](../packages/runtime/src/repository-pure-assertions.ts) implements `jevyr.repository-pure-assertions/1`. Its own result deliberately remains `authority: "none"`; parsing or computing an outcome is not authentication.

Applicability requires complete captured membership and discovery. The analyzer revalidates the single materialized subject binding, canonical manifest and each requested blob's exact length and digest. Any capture omission, missing dependency, selection limit or discovery refusal makes the whole analysis unavailable. It independently compares the selected test inventory with the pinned native default discovery patterns, including JavaScript/TypeScript filename variants, while excluding dot-components and `node_modules`. The two sets must match exactly. A native test that the diagnostic planner did not select causes refusal, not selective acceptance. This is intentionally conservative and can refuse an otherwise valid repository.

Every selected test module and its entire selected application dependency closure must fit the grammar. The evaluator does not claim to inspect unrelated application files outside that closure. Supported source modules are strict UTF-8 `.mjs` files. Optional `package.json` metadata may contain only `type: "module"` and/or the exact test script `node --test`; arbitrary package fields, scripts, loaders and dependencies are outside this fragment.

Admitted test syntax consists of direct top-level calls to the imported `node:test` test function. Each takes a literal name and a synchronous, zero-parameter arrow callback containing exactly one strict `equal` or `strictEqual` assertion, either as its expression body or in a one-statement block. The assertion comes from `node:assert/strict`; supported named aliases retain their checked bindings. It has exactly two arguments. The expected argument must be a captured integer or boolean literal, never a computed expression or model-provided expectation.

Application modules contain supported imports followed by exported pure function declarations or exported `const` arrow functions. Bodies are a single expression or a block with one return. Relative imports require explicit `.mjs` paths and named function imports. Package resolution, URL/percent decoding, queries, import attributes, dynamic imports, cycles, callbacks as values and mutable state are unsupported.

The expression grammar admits safe decimal integers, booleans, parameters, grouping, unary negation, checked integer `+`/`-`, numeric comparisons, same-domain `===`/`!==`, boolean conditionals and calls to admitted acyclic pure functions. The full syntax tree and symbol/type graphs are checked, including unused functions and untaken branches. Parser errors, missing nodes, reserved-word bindings, duplicate bindings, shadowed module names, unresolved exports, wrong arity, coercions and type conflicts are refused. There are no effects, globals, objects, property access in application expressions, loops, recursion, exceptions, async execution, `eval` or native module execution. Skips, todo, only, hooks and dynamic test registration are unsupported.

Numeric evaluation uses integer arithmetic internally and enforces the safe-integer range on literals and evaluated intermediate results. Negative zero, overflow, unsafe integers, fractional/exponential/hexadecimal syntax and non-finite values are refused. A type difference between a supported actual value and a supported expected literal is an assertion mismatch; implicit conversion is never performed.

Current hard ceilings are:

| Limit | Analyzer maximum |
| --- | ---: |
| Assertions | 64 |
| Functions | 16 |
| Parameters per function/call | 8 |
| Syntax, dependency and evaluation depth | 32 |
| Total selected/read source bytes | 256 KiB |
| Syntax nodes | 50,000 |
| Evaluation steps | 50,000 |
| Analysis certificate bytes | 8 MiB |

Callers can narrow these ceilings, not raise them. The production [execution factory](../packages/runtime/src/repository-pure-execution.ts) further limits analysis output to 500,000 bytes, complete producer output to 1,000,000 bytes and the invocation to at most 30 seconds, also bounded by the sealed resource envelope. The outer transported certificate has its own 8 MiB cap. Zero assertions or any refusal produces no supported subset, partial refutation or assertion evidence edge.

A weak but completely supported existing test suite can satisfy this finite requirement. ACCEPT does not establish adequate test coverage, absent defects, security, universal program correctness or the wisdom of the captured expectations.

## Fixed OCI production and installed assets

The [producer](../packages/runtime/src/repository-pure-producer.ts) packages fixed Judge-owned code, pinned parser/grammar Wasm, a closed request and digest-addressed captured bytes. Subject JavaScript is data. The authority producer never imports, executes or evaluates those submitted modules. The host derives a distinct [prepared context](../packages/runtime/src/repository-pure-assertions.ts) from the real sealed Case; it contains digests, the exact contract and subject metadata, and omits host locators and timestamps. It is not a fabricated or redacted Seal and cannot authenticate itself.

Production admission currently requires the built-in, startup-resolved local Docker boundary with network denied. Podman, an injected Forge/resolver and observe-only operation do not acquire this fixed factory. The wrapper binds the immutable image, exact argv, request, implementation and complete package inventory. Its `jevyr.forge-invocation-materials/2` workspace has role `empty-tooling`: an initially empty scratch area with the fixed runtime directories, no candidate ID, blueprint or selected product. Read-only materialization and complete before/after inventories are checked.

[Build packaging](../packages/runtime/PURE_PRODUCER.md) creates the fixed bundle once, writes its complete installed asset inventory and a generated descriptor pin, and ships compiler/facade provenance bytes. The synchronous installed loader verifies that pin, every asset and current runtime/core/protocol/parser input before creating the private assets object. Rehashed replacement descriptors, changed dependencies, missing provenance and extra files fail closed. Compiler provenance is verified data, not startup code or sandbox content.

Compiled startup and offline replay use those packaged assets without invoking TypeScript, tsx or esbuild. They require the declared production dependencies and complete installation. Source tools explicitly build their source-mode assets; there is no compiled-to-source fallback. Source and compiled executions therefore have different implementation identities.

## Seal, certificate, ledger and Record replay

The [original certificate](../packages/runtime/src/original-subject-certificate.ts) is a closed, bounded `jevyr.original-subject-assertion-certificate/1` object. It binds Case/run/policy/capture/subject/obligation/kernel identities and the execution receipt digest. Its exact embedded artifact inventory contains the fixed implementation, package and request, captured source/manifest data, analysis output and raw Forge observation. The analyzer output includes full assertion coverage, captured expectations, source spans, referenced functions and a bounded typed evaluation trace. No caller-supplied verdict field is accepted as authority.

Before signing and during [persisted evidence replay](../packages/runtime/src/evidence-replay.ts), the checker:

1. Authenticates the actual Seal using verifier-supplied trusted keys, validates the complete sealed Case and matches its receipt exactly. It checks the current sealed kernel, checker and factory identities.
2. Reads only the certificate's declared digest-addressed source package, never the original host locator. It rederives capture membership, discovery, closure, syntax, every assertion and the complete expected producer result. A supplied AST, hash-consistent result, reported count or expected literal cannot replace this reconstruction.
3. Revalidates the exact physical image, fixed command, source mount, empty tooling workspace, complete raw stdout, exit status, resource measurements and sealed ceilings. Producer/checker disagreement or a substituted executable is refused.
4. Requires the ordered Bone `repository-pure.evaluate` action prefix before investigation, exact certificate membership and resource linkage, and at most one matching original evidence event. Wall time includes preparation and cleanup. CPU stays explicitly unmeasured when the Forge exposes a rate limit rather than total CPU use. The outer certificate's stored bytes are charged once; embedded sidecars are not charged again when diagnostic/candidate accounting starts.
5. Derives a separate exact `verifiedOriginalSubjectEdges` tuple only for a complete match or mismatch. Core checks that tuple against the event/content/target/relation and the exact original binding. The event has no candidate ID, assay ID, formal certificate or audit alias. An evidence label, graph serialization or ordinary sandbox allowlist cannot grant this authority.

The low-level analyzer and physical replay helpers continue to return `authority: "none"`; even a physically consistent result does not authenticate a Record. The full [ordinary proof exporter/verifier](../apps/cli/src/local-proof.ts) additionally validates the signed Seal, Record and terminal closure, full sealed Case, event chain, artifact inventory and required run attestations. It passes only authenticated context and independently reconstructed edges to policy replay. An offline caller may pin the signer externally; otherwise trust remains explicitly limited to the proof-declared key. Certificate-only harnesses are not a substitute for signed Record closure.

Production and replay reuse trusted parser/evaluator code. This is independent of submitted program execution and messages, not a claim of two independently implemented semantics. The parser, closed evaluator, verifier host, cryptography, signing process and Forge isolation remain part of the trusted computing base.

## Denial, unsupported input and historical behavior

A missing fixed factory or a preflight capture/resource refusal emits a denied action with no authority edge. Its authenticated original purpose remains in force. A successfully executed producer can also return an unavailable analysis for unsupported source; that certificate is retained but provides no support or refutation. In both cases the exact original obligation stays UNPROVEN unless a separate integrity condition prevents judgment.

An OCI capability lost after admission, inconsistent execution, truncated output or claimed certificate that fails reconstruction never becomes a test failure. These execution/integrity failures fail closed and can make the Case INVALID; they do not manufacture original-source REJECT. Startup absence follows the explicitly sealed missing-execution policy: `UNPROVEN` allows disclosed observe-only preflight, while strict legacy `INVALID` remains available.

The diagnostic repository observer, ordinary untrusted suite reports and model-authored reports keep their existing lack of original assertion authority. The current orchestrator selects the pure route for applicable v2 purposes; it does not reinterpret previous observer artifacts. Formal arithmetic counterexamples retain their separate grammar and authority. Old v1 proofs retain their old policy bytes. Exact earlier source/checker identities are not silently replayed with a newer implementation under the old fingerprint.

## Retained source and installed evidence

These checkpoints establish different claims and must not be merged into a single release result:

| Retained evidence | What was measured |
| --- | --- |
| [Diagnostic observer proof](../artifacts/repository-observer-proof-1788595421553/report.json) | Three actual Docker fixtures: clean, failing and empty. All remained VALID/UNPROVEN because observer counts are diagnostic. |
| [Historical source lifecycle 1788602679261](../artifacts/original-subject-lifecycle-1788602679261/report.json) | Three complete source-mode signed lifecycles with real Docker: clean ACCEPT, defect REJECT, unsupported UNPROVEN. Each had truthful FAILED/NOT_BUILT creation/embodiment and a silent synthetic Mind. This predates the final original-versus-candidate scope and checker corrections. |
| [Historical CLI proof validation](../artifacts/original-subject-lifecycle-1788602679261/cli-proof-validation.json) | All three historical ordinary exports verified; four positive/adversarial offline tests passed with six method files unchanged during that check. It used a read-only retained-store fetch seam and performed no new Docker or model calls. |
| [Final-source certificate proof](../artifacts/original-subject-certificate-final-source-1788603754111/report.json) and [fresh-process retained replay](../artifacts/original-subject-certificate-final-source-1788603754111/independent-verification.json) | Three actual fixed-OCI match/mismatch/unavailable fixtures, six test groups passed. All three retained certificates replayed successfully. A rehashed 25,001 ms receipt was refused against a 25,000 ms sealed frontier. This harness authenticates fixture-declared Seals and ledger joins, not a whole signed Record closure. |
| [Packaged loader validation](../artifacts/repository-pure-packaging-validation-1788602906886/report.json) | Twelve packaging/producer tests passed, including a private compiled installation without development dependencies and refusals for rehashed substitution and dependency drift. No workspace dist build or deployment was performed by that validation. |
| [Installed production build](../artifacts/original-subject-installed-build.log) and [807-file freeze](../artifacts/original-subject-installed-freeze.json) | The complete workspace build passed. The freeze records compiled core/runtime/daemon/CLI/SDK dependencies, packaged producer, checker and investigation identities. |
| [Installed full lifecycle proof](../artifacts/original-subject-installed-lifecycle-1788604306738/report.json) and [fresh-process offline verification](../artifacts/original-subject-installed-lifecycle-1788604306738/independent-verification.json) | All three predeclared attempts passed through the actual compiled daemon, ordinary HTTP Cast, real fixed Docker execution, signed closure, SDK export and CLI replay. Clean ACCEPT, defect REJECT and unsupported UNPROVEN all retain FAILED/NOT_BUILT. Each has one original certificate; candidate sandbox execution counts are zero and must not be mistaken for zero original evaluator executions. Method and packaged asset inventories were unchanged. A silent synthetic Mind was used, with no model calls. |
| [Installed Record browser check](../artifacts/record-browser-qa/clean/report.json) | The real signed clean proof is displayed through a read-only retained-proof HTTP adapter. Evidence navigation, verified certificate download, altered-byte refusal and delayed-request isolation pass at 320, 736 and 1024 pixels, with no browser errors. This does not create another Case or execute Docker again. |
| [Compiled offline adversarial checks](../artifacts/original-subject-installed-offline-adversarial-1788604919777/report.json) | Four fresh-process checks passed: positive verification and refusals for a missing certificate, reduced context replacing the full Seal, and rehashed inner source. The original proof and all compiled bytes remained unchanged; no new model or Docker invocation occurred. A separately retained Vitest attempt resolved development sources and refused the compiled kernel identity before its four tests could run. |
| [Local activation](../artifacts/bone-v2-local-activation-1788604906851/activation.json), [deployed method inventory](../artifacts/original-subject-installed-freeze-deployed.json) and [live browser check](../artifacts/ds-judge-live-browser-original-authority/report.json) | The project policy changed from bone-v1 to bone-v2 and the standard local service restarted. All 807 compiled files still match the measured freeze. Live Airlock, Genome Lab and authenticated Record routes pass the three required widths. The named startup self-audit is separately INVALID after a provider failure and replays correctly; this is not evidence of a repository defect. |

The current core source suite has 111 passing tests, including TypeScript/Wasm/Reflex scope parity. [Analyzer tests](../packages/runtime/test/repository-pure-assertions.test.ts) include strict grammar/coverage/numeric refusals, immutable input and rehashed-analysis checks, and 16 finite generated arithmetic fixtures. [Producer tests](../packages/runtime/test/repository-pure-producer.test.ts) include an actual Node 24 discovery fixture with twelve selected patterns and ten excluded controls. These bounded checks are not a general proof of JavaScript semantic equivalence or model investigation quality.

The [compiled lifecycle script](../scripts/original-subject-lifecycle-proof.mjs) retained every clean/defect/unsupported attempt, used the installed synchronous producer loader and actual daemon/HTTP Cast/export, verified signed closure and offline replay, and compared the loaded implementation identities. Deployment into the user's ongoing local service is recorded separately from these controlled fixtures. Later investigation repairs and production packaging have their own [current implementation inventory](ds-judge-gates.md). The successful three-proof upgrade check does not guarantee compatibility after a future change to a required authority identity.

None of the pure evaluator, synthetic-Mind or packaging fixtures qualifies a language model. They establish a deterministic authority path for a narrow existing-test requirement. Actual model investigation success/failure, source inspection, generated executable quality, cross-family performance and other release gates remain separately measured.
