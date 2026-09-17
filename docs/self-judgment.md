# Repository self-judgment

The daemon's `createRuntimeSelfJudge` connects the bounded repository watcher to ordinary signed Cases, independent evidence replay, and quarantined offspring storage. `JEVYR_SELF_JUDGE=1` enables it; omission or `0` disables it. `JEVYR_SELF_JUDGE_INTERVAL_MS` accepts an integer between 10,000 and 3,600,000 milliseconds and defaults to 60,000. Runtime startup starts the watcher after readiness; shutdown stops it.

`JEVYR_SELF_JUDGE_CASE_FILE` optionally names a finite JSON mission captured once at startup. The file accepts exactly this shape:

```json
{
  "protocol": "jevyr.self-judge-mission/1",
  "impulse": "`node /subject/subject-0000/repository.test.mjs` exits with code 0.",
  "constraints": ["Execute the captured repository test from the read-only subject mount."],
  "requestedAssays": []
}
```

The example requires an operator-sealed frontier containing that exact command and a captured `repository.test.mjs`; it grants no new assay. `own-repository` is the first sorted subject and is materialized at `/subject/subject-0000`. A command that runs a candidate-generated replacement test does not establish the repository's correctness. The generic `sealedTestSuite` evaluator remains unavailable and cannot be authorized merely by supplying a suite digest. Without a configured finite mission and applicable assay, the default general audit remains `UNPROVEN`.

Mission files are bounded to 128 KiB, 32,768 impulse characters, and 32 entries per constraint or assay list. Unknown authority fields, duplicate JSON keys, invalid UTF-8, file aliases, and relative paths escaping the project are refused. An explicitly absolute broker path is allowed. Later file edits take effect at the next daemon startup. The driver owns subjects, privacy, control, and seed, so a mission cannot change them.

Each iteration captures permitted source files into a separate temporary directory. The version-two capture manifest lists relative paths, byte counts, SHA-256 digests, and the startup mission digest, with a canonical digest for the complete manifest. Its digest supplies the 256-bit Case seed. Source byte or path changes trigger a new investigation. Timestamp changes, unchanged captures, and changes in excluded output directories remain quiet. A running investigation suppresses overlapping ticks. The interval begins after the previous tick finishes; shutdown cancels the timer and passes an abort signal to the active self Case.

The source allowlist includes ordinary code, configuration, documentation, policy, and workflow formats. Hidden directories other than `.github`, `.git`, `node_modules`, `artifacts`, `.jevyr`, build outputs, caches, secret directories, credential files, environment files, and private-key file formats are excluded. Symbolic links are skipped; hard-linked files, changed-during-read files, escaped paths, and over-budget captures are refused. This is a bounded source-file policy, not a claim that arbitrary source text can never contain a secret. Keep credentials in the configured broker or excluded credential files.

Defaults are 4,096 source files, one MiB per file, and 32 MiB total. The constructor permits explicit finite limits up to 16,384 files, four MiB per file, and 128 MiB total. Reads and traversal have independent bounds. Temporary directories are removed after the Case callback finishes, including on errors; cleanup checks that its target is within the temporary directory and has the driver-owned prefix.

The submitted Case is always `sovereign` and `local_only`. Its subjects are the copied repository and the capture manifest. The normal sealing path therefore captures the manifest and source as ordinary signed Case material. The driver does not execute source itself, change the original checkout, expand permitted assays, sign governance promotions, or select a new active Genome. The runtime callback awaits terminal closure, verifies all three signatures and their payload purposes, checks the ledger and artifact digests, and independently replays physical assay evidence. Its abort signal targets only that Case.

An offspring callback requires an independently verified proof and either `INVALID` integrity with explicit binding-failure evidence, or `VALID` integrity with `REJECT` judgment and independently reproduced critical-defect evidence. The callback result keeps `bindingFailures` and optional `reproducedDefects` separate. A provider opinion, an unverified result, or an unexplained negative verdict does not authorize a proposal. The callback must use the existing quarantined proposal mechanism and must not sign or promote it. Successful Case manifests are deduplicated for the driver's lifetime, including cases that report failure. The daemon integration is responsible for durable case and proposal persistence.

`createSelfJudgeProposalRecorder` in `self-judge-proposals.ts` implements that persistence through the existing Genome registry. For an active governed parent, it preserves Bone and modules, proposes at most one step of tighter challenge cadence, and stages the descendant with empty benchmark and damage evidence and zero measured novelty. The governance gate therefore rejects it pending actual evidence. The static baseline instead produces an explicit request for a governed parent and a generation-zero candidate using the three existing built-in modules; it never invents a promoted lineage. Both paths store content-addressed `self-judge-requests` entries linking the Case, run, source manifest, optional Record digest, and failure observations. They expose no key, promotion, or activation operation. Tighter cadence is a proposed experiment, not a demonstrated fix.

Focused verification:

```powershell
node apps/cli/node_modules/tsx/dist/cli.mjs --conditions=development --test apps/daemon/test/self-judge.test.ts
node apps/cli/node_modules/tsx/dist/cli.mjs --conditions=development --test apps/daemon/test/self-judge-proposals.test.ts
node apps/cli/node_modules/tsx/dist/cli.mjs --conditions=development --test apps/daemon/test/self-judge-mission.test.ts apps/daemon/test/self-judge-runtime.test.ts
pnpm --filter @jevyr/daemon typecheck
```

The runtime tests create actual signed Cases: an observe-only audit closes `VALID / UNPROVEN` without an offspring request; a sealed unavailable investigator closes `INVALID` and records one quarantined request linked to the same signed Record and independently verified Bone failure event. These are controlled integration measurements, not a claim that the repository's complete test suite has passed its own judgment.

The [immutable-source defect proof](../artifacts/self-judgment-defect-1788585279683/report.json) runs a copied project with a planted subtraction-for-addition bug. Three actual Docker cells execute the captured repository test from `/subject`, observe `-1` against expected `5`, and close `VALID / REJECT`. Candidate blueprints deliberately contain passing replacement tests; they cannot override the immutable command. The watcher records one quarantined request linked to the same signed Record and all three physical failure digests, then remains quiet on unchanged source.

[Independent verification](../artifacts/self-judgment-defect-1788585279683/self-proof-verification.json) checks all ordinary signatures, authenticated replay, exported private-CAS fixture manifests and blobs against the signed subject-capture digest, actual read-only mount and materialization bindings, and the offspring request's exact run, Genome, Record, manifest, quarantine decision, and evidence links. [Adversarial checks](../artifacts/self-proof-adversarial-final-1788585279683/adversarial-checks.json) reject a substituted passing test and a rehashed request naming absent failure evidence. This explicitly exported fixture contains only the controlled arithmetic project; ordinary public proof export does not publish arbitrary private source.

Reproduce the controlled source-condition experiment:

```powershell
node apps/cli/node_modules/tsx/dist/cli.mjs --conditions=development scripts/self-judgment-defect-proof.ts
node apps/cli/node_modules/tsx/dist/cli.mjs --conditions=development benchmarks/verify-self-judgment-proof.mjs artifacts/self-judgment-defect-1788585279683 --development
```

The earlier [first executed defect run](../artifacts/self-judgment-defect-1788582203799/report.json) retained a real integration failure: its signed `REJECT` did not produce an offspring request because the intake expected a flagship-level refutation. The extractor was corrected to accept independently replayed critical failures supporting the exact closed-population rejection basis. It does not convert `UNPROVEN`, testimony, or an unexplained negative verdict into a proposal.

The earlier [pre-freeze complete proof](../artifacts/self-judgment-defect-1788582363705/report.json) remains available as historical evidence; the linked current proof was rerun after the final runtime freeze.
