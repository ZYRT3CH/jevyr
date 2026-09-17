# Offline replay release

The replay release preserves the matching compiled verifier as a directory and ZIP. It verifies ordinary exported proofs without a source checkout, daemon, models, Docker, private store or development package dependencies. It is a verifier archive, not a standalone installation of the full DS Judge application.

The archive contains the existing compiled CLI `local-proof.js` and `replay.js`, the compiled runtime/core/protocol/SDK/growth/memory packages, both constitutional policy versions, the fixed producer and its provenance, and required production dependencies. Compiled files are copied byte-for-byte. Parser and grammar identities remain checked by the existing verifier. Build-tool bytes retained inside producer provenance are inert evidence; no compiler package or executable build path is installed or invoked.

## Build from a frozen installation

Use Node 24 and an already built checkout. No dependency installation or build is performed by this command:

```powershell
node scripts/replay-release-build.mjs artifacts/replay-release-NEW artifacts/original-subject-installed-freeze.json
```

The output directory must not exist. The builder checks the complete frozen inventory before and after capture, copies immutable buffers into a fresh directory, rechecks every selected source and destination, and writes sibling `.zip` and `.build.json` files. The ZIP uses ordinary relative paths and contains the exact directory files. Bounds are 20,000 files, 32 MB per file and 256 MB total; unresolved or conflicting production dependencies are refused. No package scripts run. Optional inference SDKs, application credentials, signing keys, proof exports and the private Case store are not copied.

## Verify a separately supplied proof

Keep three things separate: the verifier release, the ordinary proof export and the trusted signer fingerprint. Obtain the expected ZIP and release-manifest digests from a trusted release channel and the proof signer fingerprint from an independent source. **Verify the ZIP digest using a trusted system tool before extracting or executing it**, for example `Get-FileHash -LiteralPath 'C:\downloads\replay-release.zip' -Algorithm SHA256`, and compare it with the independently obtained value. The verifier cannot authenticate its own bootstrap code merely by checking itself. The adjacent unsigned build receipt and the proof's own `trust.json` cannot establish those trust decisions.

After extracting the release to an ordinary directory, use its `verify.mjs` with Node **24.x**. For example:

```powershell
$replayRelease = 'C:\replay\judge-release'
$replayProof = 'C:\replay\case-proof'
$replaySigner = 'sha256:REPLACE_WITH_INDEPENDENTLY_TRUSTED_SIGNER'
$replayDigest = 'sha256:REPLACE_WITH_TRUSTED_RELEASE_MANIFEST_DIGEST'
node --permission "--allow-fs-read=$replayRelease" "--allow-fs-read=$replayProof" "$replayRelease\verify.mjs" --proof "$replayProof" --signer-key "$replaySigner" --release-digest "$replayDigest"
```

The entry requires the explicit proof and both pins, verifies the canonical release manifest and complete exact file inventory before importing the compiled verifier, and checks that inventory again afterward. Missing, changed, additional or linked release files are refused. It requires Node's permission mode with child-process, worker and filesystem-write permission denied, and disables the network APIs used by the verifier. Grant filesystem reads only to the release and proof directories. Keep both directories protected from concurrent modification; digest checks are not an operating-system immutability guarantee.

The unchanged verifier authenticates Seal, Record, terminal closure and exact artifact inventory, then independently reconstructs the original-source certificate from retained source bytes. A successful result does not run the repository's code, repeat the physical experiment, or establish model quality. A proof replay may still fail when supplied to a different verifier release; archive the matching release rather than rewriting historical identities. No automatic legacy-verifier download or dispatch is implemented.

## Local isolation evidence

The current archive is [replay-release-original-authority-1788605974884](../artifacts/replay-release-original-authority-1788605974884.build.json), with [ZIP](../artifacts/replay-release-original-authority-1788605974884.zip). It captures **1,109 files in 17 packages**, 21,289,307 uncompressed bytes and 7,763,324 ZIP bytes, with all **807 frozen installation files unchanged**. Its manifest digest is `sha256:47ceeffa85cf7a3be045b498e0b7db206ac8e70c084a8f14d79cac7a65c317a5`. This paragraph records local build evidence, not publisher authentication.

The isolation harness extracts the ZIP outside the checkout and copies the proofs separately. Every fresh Node process has read access only to that installation and its proof; an attempted checkout read is denied. Child/worker/write permissions are denied, and resolution of `tsx`, `esbuild`, `typescript`, `@jevyr/daemon` and `@jevyr/cli` fails. The three retained compiled original-source Cases reconstruct their exact ACCEPT, REJECT and UNPROVEN Records. Additional checks refuse a missing parser asset, changed checker, changed manifest, wrong signer and absent release digest.

Run the bounded retained-proof test without a rebuild:

```powershell
node scripts/replay-release-test.mjs artifacts/replay-release-original-authority-1788605974884 artifacts/original-subject-installed-lifecycle-1788604306738 artifacts/replay-release-validation-NEW
```

The final [isolation, network-denial and adversarial report](../artifacts/replay-release-validation-network-1788605974884/report.json) records **8 passed, 0 failed, 0 skipped**, on Node 24.16.0. After successful replay, direct fetch and socket attempts are refused before a request or connection. The earlier [corrected isolation run](../artifacts/replay-release-validation-final-1788605974884/report.json) is also retained. The initial [7/8 harness run](../artifacts/replay-release-validation-1788605974884/report.json) accidentally supplied the release digest in its absent-digest test, so it correctly replayed. The harness flag was corrected without changing the archive or existing verifier. Cross-platform execution beyond this Windows/Node checkpoint is not measured.
