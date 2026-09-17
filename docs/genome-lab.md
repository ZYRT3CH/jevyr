# Genome Lab, paired measurements and local presets

`jevyr genome inspect --json` reads the active startup Genome, quarantined proposals, signed presets and selection provenance. `GET /v1/genome-lab` exposes the same startup selection for a read-only view. It has no promotion route. The optional `preset` response contains `mode`, `selectionDigest`, `descriptor` and `applies: "next-runtime-startup"`; the descriptor embeds the signed benchmark, signed preset and effective finite runtime profile. The SDK verifies its descriptor digest.

Genome authority remains separate from case authority. Set `JEVYR_GENOME_GOVERNANCE_TRUST_FILE` to the existing closed public Ed25519 governance trust file. `JEVYR_GENOME_REGISTRY_DIR` and `JEVYR_PRESET_REGISTRY_DIR` optionally select local stores; defaults are `<dataDir>/genome-registry` and `<dataDir>/presets`. Neither startup, inspect, propose, use nor off generates signing keys or signatures.

## Recorded paired benchmark analysis

The original `jevyr benchmark --corpus FILE` executes the ordinary lifecycle corpus. The following explicit subcommands analyze recorded paired Genome experiments:

```text
jevyr benchmark build --file paired-input.json --report unsigned-metrics.json
jevyr benchmark run --file paired-input.json --signing-key-ref env:BENCHMARK_KEY --report signed-metrics.json
jevyr benchmark compare --file signed-metrics.json --json
```

`build` and `run` both independently replay every referenced terminal proof under its separately pinned signer before compiling metrics. Here `run` means the recorded benchmark analysis: it does not launch new cases. `run` additionally signs with the explicitly supplied Ed25519 private PEM broker reference. The key must already be trusted in the governance trust file. The private material is never copied into a report or store. Outputs use exclusive creation and do not replace files.

The exact input is `{configurations, trials, proofs, corpus}`. Types are exported by `@jevyr/growth` as `PairedBenchmarkConfiguration`, `PairedGenomeTrial` and `PairedFixtureCorpus`. Every proof reference is exactly `{recordDigest, directory, signerKeyId}`. `replayDigest` hashes the verified local proof report with only its machine-specific `directory` field removed. A trial's `recordDigest`, exact `evidenceDigest`, subject capture digest, Genome digest and verdict must agree with that replay. New proof exports include `sealed-case.json`, validated against the authenticated Seal; older proofs lacking this supplemental specification remain historical proofs but cannot supply the seed binding needed for a new benchmark.

Every case/seed/provider snapshot/repeat key must include every configuration with the same subject and ground-truth labels. Missing arms fail compilation. The CLI recomputes `seedDigest` from the revealed sealed seed and `providerSnapshotDigest` from the sealed policy's exact `mindCapabilities`. It compares the configuration against the sealed effective runtime profile and binds the corpus impulse, constraints, source files, critical command predicates and defect labels to that Case. Trials preserve INVALID infrastructure failures explicitly. Ground truth and measurement annotations still need an honest predeclared experiment: this analysis does not claim blind held-out performance merely because an operator signed a manifest.

Protocol `jevyr.genome-benchmark/2` keeps separate critical-defect recall, false-positive clean-case rate, UNPROVEN rate, physical-result reproducibility, coverage, wall time, tokens, cross-family binary finding correlation, and additional decisive evidence per additional cost unit. `physicalObservationDigest` is independently derived from authenticated candidate assay artifacts: an unordered multiset of exact command/arguments, assay status, exit result, OCI image and complete stdout/stderr bytes. Execution multiplicity remains significant. Run IDs, timestamps and candidate source comments do not participate; this metric does not assert identical source or causal lineage. The original `evidenceDigest` remains the exact signed evidence commitment. A repeated case/seed/provider group counts once and reproduces only if every repeat has the same physical result digest and judgment. Missing or incomplete captures make the metric unmeasured.

All v2 rates and means are explicitly **descriptive fixture measurements**, with `interval95: null`; repeating the same fixture does not manufacture independent population samples or inferential confidence. Coverage, costs and marginal observations must exist for every trial to produce those values. Constant lane vectors and absent replicate groups are unmeasured, not zero. Correlation is association, never evidence of causal independence. Historical v1 reports preserve their original byte-evidence metric semantics; v2 does not reinterpret their signatures.

Pareto comparison uses all nine measured point estimates and preserves tradeoffs. It does not compress them into one quality score. A configuration with any unmeasured dimension cannot authorize a preset; INVALID trials also prevent admission. The report exposes intervals and limitations alongside its Pareto set.

## Explicit local selection

```text
jevyr preset save --file signed-metrics.json --name "Measured compact" --configuration sha256:... --signing-key-ref env:PRESET_KEY
jevyr preset use sha256:...
jevyr preset off
jevyr preset wild
```

Saving verifies the benchmark signature, independently recomputes its metrics and Pareto set, then signs the exact chosen preset with the explicitly supplied key. Saving does not select it. Using a preset verifies both signatures and the current Genome/Bone binding. Wild/off atomically removes the preset selection. These local pointer changes apply at the **next runtime startup**; existing runtime snapshots and sealed cases stay unchanged. Wild removes only preset restrictions: it does not turn off Bone, the active Genome, resource policy or sandbox boundaries. The next runtime seals the full selection and effective composition in policy provenance.

## Quarantine and human promotion

```text
jevyr genome propose --file proposal-import.json --report reviewed-proposal.json
jevyr genome promote sha256:PROPOSAL --attestation human-governance.dsse.json
```

The proposal import is exactly `{parent, proposal, benchmarks}`: an existing stored-Genome shape, a complete finite `GrowthProposal`, and trusted signed paired benchmark reports. Each proposal benchmark reference must identify one of those reports containing both parent and descendant configurations. The built-in catalog compiler validates the descendant against the running Bone. Existing admission requirements still apply, including held-out evidence, damage trials and material gain. The command imports and quarantines a proposal; it does not invent scores, run damage trials, or make a signature into execution evidence. A STAGED proposal prints the exact `genomePromotionPayload` for independent human signing. Promotion consumes that separately supplied governance attestation and never signs it automatically. Activation affects the next startup.

## Fresh retained experiment and populated view

The [fresh signed paired report](../artifacts/paired-genome-1788585289506/benchmark.json) evaluates two unpromoted Genome profiles on a clean four-predicate fixture and a fixture with two planted defects, using one shared seed and two repetitions of each configuration. All eight Cases independently replay: four `ACCEPT` and four `REJECT`, with 64 Docker predicate executions. The [independent verification](../artifacts/paired-genome-1788585289506/independent-verification.json) authenticates every separately pinned terminal proof, verifies the revealed seed, provider snapshot, corpus and profile bindings, reconstructs physical-result digests, and recomputes the signed report. Every Case also retains its full `proof/replay.json`, canonical Record bytes, and fixed-purpose production/advisory attestations.

The [scope record](../artifacts/paired-genome-1788585289506/scope.json) identifies mechanical providers with no language model, zero model-token usage, and actual separately charged output bytes. The two provider families share a reproduction algorithm. These eight repetitions are descriptive fixture measurements; they do not establish general defect recall, independent model reasoning, or population confidence. The report measures the frozen compiled packages. Its Bone identity must match the compiled startup used for selection; a development/source-mode identity is not interchangeable with it.

The [populated startup fixture](../artifacts/genome-lab-current-ui-1788585533847/report.json) verified the paired report again, selected a matching preset using an isolated, explicitly TEST-only governance key, and independently replayed the [fresh self-judgment defect proof](../artifacts/self-judgment-defect-1788585279683/self-proof-verification.json) before copying its quarantined request. No real registry was promoted or selected, and the test private key was not persisted. The [browser report](../artifacts/genome-lab-browser-qa/genome-lab-current-ui-1788585533847/report.json) covers all nine metrics, exact provenance and request digest, keyboard access, reduced motion, and 320/736/1024-pixel layouts. The temporary read-only daemon was stopped after verification.

To create and independently verify another finite experiment after building, run `pnpm proof:genome`, then `node scripts/verify-paired-genome.mjs artifacts/paired-genome-<timestamp>`. Verification writes a new report with exclusive creation and does not replace retained evidence. The read-only QA helper accepts the paired directory and a separately retained self-proof directory: `pnpm --filter @jevyr/daemon exec tsx scripts/current-genome-lab-ui-fixture.ts PAIRED_DIRECTORY SELF_PROOF_DIRECTORY`. Run that helper against the matching compiled build, without development conditions.
