# Standalone local application release

The application release contains a matching compiled CLI, daemon, runtime, Chamber, and a bounded closure of their production dependencies. It requires a separately installed Node.js 24 runtime. The launcher imports vinext's official production server API directly; it does not run pnpm, a source compiler, the vinext development CLI, or the project's build configuration.

The builder is `scripts/app-release-build.mjs`. Capture is permitted only from an approved, unchanged compiled freeze:

```powershell
node scripts/app-release-build.mjs NEW_RELEASE_DIRECTORY APPROVED_COMPILED_FREEZE_JSON [VERIFIED_CALIBRATION_ARTIFACT_DIRECTORY]
```

It produces a directory, a ZIP alongside it, and a `.build.json` receipt with the ZIP digest, manifest digest, file count, dependency inventory, and platform. Inputs are captured as detached bytes and checked again after writing. The builder neither installs dependencies nor copies the root `node_modules` tree indiscriminately. It preserves the required sibling `apps/cli` and `apps/chamber` layout and installs each captured dependency at an explicit package-resolution location.

The current builder targets the operating system and architecture where capture occurs. The launcher refuses a different platform. A successful Windows x64 check would establish Windows x64 operation only; it would not establish Linux, macOS, ARM, or every optional native adapter. Node, Docker or Podman, model weights and model servers remain separately installed substrates. Optional native agent SDKs are outside this local HTTP-provider package profile. The release manifest records omitted optional and build-only dependencies.

Before executing any JavaScript from the archive, obtain its expected ZIP digest through a trusted independent channel and compare it with a system hashing tool. For example, on Windows:

```powershell
Get-FileHash -Algorithm SHA256 DOWNLOADED_RELEASE.zip
```

The unsigned local manifest and its self-hashes establish byte consistency, not publisher identity. The manifest digest must likewise come from that trusted channel. Extract to a dedicated application directory. Create or choose an existing project directory outside the application tree, then launch commands with its absolute path:

```powershell
node APPLICATION_DIRECTORY/start.mjs --project ABSOLUTE_PROJECT_DIRECTORY --release-digest sha256:EXPECTED_MANIFEST_DIGEST -- init
node APPLICATION_DIRECTORY/start.mjs --project ABSOLUTE_PROJECT_DIRECTORY --release-digest sha256:EXPECTED_MANIFEST_DIGEST -- doctor --json
node APPLICATION_DIRECTORY/start.mjs --project ABSOLUTE_PROJECT_DIRECTORY --release-digest sha256:EXPECTED_MANIFEST_DIGEST -- up
```

Every launch checks the entire manifest inventory before importing the existing compiled CLI. Missing, substituted, extra, linked, or malformed inventory entries are refused. Application and project directories must be separate: neither may contain the other. Configuration, captures, Cases, signing keys, calibrations, and governance choices belong to the project. No existing `.jevyr` store, private key, credential, or operator configuration is copied into the release.

The production build selects Bone v2 for fresh `init`; existing project policy files retain their explicit version. Fresh projects have no measured metabolic calibration unless matching evidence is separately installed. Shipping application bytes does not provide model configuration, a new empirical experiment, or governance approval. Existing project state must be migrated or configured deliberately rather than copied from the builder's private workspace.

The optional calibration resource is captured only from a controlled artifact directory after independent verification of all five kinds across 64 paired seeds and 320 reexecuted trusted sources. Its selected reports, exact raw sidecars and independent verification are included in the release inventory. The builder independently verifies those bytes again at their captured destination. It does not read the builder's `.jevyr` installation. When the manifest includes this resource, the operator may explicitly install it:

```powershell
node APPLICATION_DIRECTORY/start.mjs --project ABSOLUTE_PROJECT_DIRECTORY --release-digest sha256:EXPECTED_MANIFEST_DIGEST -- install-calibration
```

The installer requires the current compiled method identity and matching verified summaries. It creates an exclusive per-project lock, validates a private sibling staging tree, rereads exact membership, then publishes it by a same-parent rename. Existing installations are refused without alteration; failed staging is retained for inspection and is never the daemon's configured calibration directory. There is no copy/merge fallback and `init` never installs calibration automatically. Consumer installation verifies trusted release bytes and method compatibility; it does **not** rerun the experiment. These are finite scheduler measurements, not an estimate of language-model efficacy or general defect recall.

The base production package is measured by `artifacts/app-release-production-base-proof-1788608901973/report.json`: eight checks passed from a ZIP extracted outside the checkout. A fresh project initialized Bone v2, the daemon and all four production routes responded, the CLI doctor correctly reported missing model/execution substrates, and a template-only Case reached a signed VALID/UNPROVEN Record that independently replayed from its ordinary export. Missing/substituted release bytes were refused, and the application inventory remained unchanged. The package has 5,244 files in 162 packages: 58,485,577 bytes before compression and a 17,533,004-byte ZIP. This is Windows x64 evidence with Node 24, no model calls and no Docker in the child PATH.

The final calibrated archive is `artifacts/app-release-production-calibrated-1788609632310.zip`, built from the 929-file `production-launch-final-freeze.json`. It contains 10,038 files in 162 packages, totaling 100,075,531 uncompressed bytes; the ZIP is 28,874,047 bytes. Its local build receipt and manifest are retained alongside the directory. Expected local digests are:

```text
ZIP      sha256:eb96ca65b13586c839c261d19b7ba89a0d70d532da7e01bfdef4f9895eb6d360
manifest sha256:fd20a271a1e2449e21a2c826f3c8ede5ca3b64c5694ec05d08adb5869ba97262
```

`artifacts/app-release-production-calibrated-proof-1788609706608/report.json` records ten passing outside-checkout checks. These include explicit installation of the immutable calibration, refusal to replace it, production routes/doctor, a fresh signed VALID/UNPROVEN Record with ordinary offline replay, unchanged application bytes, and missing/substituted-file refusals. The builder independently reexecuted 320 trusted sources against the captured resource; it contains the exact 4,788 independently checked raw artifacts plus five reports and their verification document. The consumer install performed no new experiment.

`artifacts/app-release-production-cold-proof-1788609800628/report.json` records five passing checks of the real Windows opener. The exact editable Airlock URL was announced while the newly started daemon and Chamber remained alive, both responded, and opening the editor neither changed the Case inventory nor the application bytes. The proof then stopped its owned processes. Hydrated DOM inspection is recorded separately; an opener's successful return alone is not a browser assertion.

The separate Edge DOM run is retained at `artifacts/standalone-production-browser-1788610100002`. All 15 functional checks passed: exact directory/API prefill, four routes at 320/736/1024 widths, no overflow, and the authenticated retained Record. Its strict no-console-errors report **failed** because the browser automatically requested `/favicon.ico`, which returned 404. There were zero API, JavaScript, stylesheet, or evidence-request failures. `diagnostic-404.json` records the exact request; `functional-summary.json` preserves the narrower passing scope without rescoring the strict report. The cosmetic follow-up is to link the existing `favicon.svg` explicitly in the document. The frozen archive has not been rewritten to hide this failure.

The browser run observed the same extracted release after an ordinary `up --no-open` restart: the first cold window expired while a test-only accessible-label selector was being corrected. Those harness failures are retained separately. The read-only restart issued no second opener, saved no draft, sealed no Case, and stopped only its owned application processes after inspection. Existing browser registrations and unrelated tabs were not changed.

The final archive also replays the three earlier original-source ACCEPT/REJECT/UNPROVEN proofs with identical original Record digests and separately supplied original signer pins: `artifacts/app-release-historical-replay-1788609961005/report.json`, three passing fresh-process checks. Node filesystem permissions allowed reads only from the extracted application and copied proof, denied checkout reads, and denied child/worker/write permissions. This is a measured matching-authority upgrade check, not a new adjudication or universal legacy-verifier dispatch. Retain a matching replay release for future updates that change required checker, kernel, or producer identities.

Nine synthetic inventory, dependency-resolution, launcher and calibration-publication tests pass with `node --test scripts/app-release.test.mjs`. Failed attempts remain available: the first base proof (`app-release-production-base-proof-1788608839614`) expected the wrong doctor exit code, while the application correctly returned blocked-readiness code 3; the earlier capture refusal (`app-release-production-base-1788608737270.log`) omitted Vite's literal `~` filenames from a path allowlist; and the first historical replay harness (`app-release-historical-replay-1788609899942`) compared the valid computed Record digest to an absent field in the wrong metadata document. Corrected checks read the proper explicit expected values without changing verifier behavior or historical artifacts.

These packaging checks do not establish language-model quality, physical Forge execution, original-source adjudication, or separate Couch/Horizon behavior. Historical replay-only archives remain useful for their matching proof-verification scope and are not this full application release.

The Connections checkpoint is additionally packaged at `artifacts/app-release-provider-connections-1788628007107.zip`, captured from the unchanged 950-file `provider-connections-installed-freeze.json`. Earlier archives and reports remain intact. This Windows x64 / Node 24 archive contains 10,047 files in 162 packages, totaling 100,211,702 uncompressed bytes; the ZIP is 28,914,903 bytes. Its expected local digests are:

```text
ZIP      sha256:2ac51e8d86dc1865c510579fa3c077693bd12125c5ce22394516d654c84ebc05
manifest sha256:9c3158d3d30770ac2bfcc951b23b243d5b76cb705f06e190ed1d6b26526f6349
```

`artifacts/app-release-provider-connections-proof-1788628007107/report.json` records 12 passing checks from a fresh ZIP extraction and separate project outside the checkout. All five production routes, including `/connections`, responded with the correct daemon origin. The packaged SDK saved a profile containing no HTTP models or MCP servers, verified that it remained pending while the existing runtime continued, refused a stale revision and hostile Origin, and observed the same profile become active after a clean restart. The test changed only its isolated project's settings and stopped its owned services. This archive probe checks HTTP/SDK behavior; hydrated browser behavior is covered separately by the production Connections UI reports.

The same probe installed the optional immutable calibration, refused to replace an existing installation, obtained a fresh signed VALID/UNPROVEN template Record, replayed its ordinary export, and refused missing or substituted application files. The application inventory remained unchanged. The included calibration uses the unchanged `sha256:9e800eb68743640e5e6ad82f67d1ad796c9c00b9dc2eeac82a1631020c5c6a20` method and controlled `metabolic-calibration-production-launch-1788608673726` evidence. Capture independently reverified its 320 trusted-source reexecutions and 4,788 raw artifacts at the release destination; explicit consumer installation did not run a new experiment.

The Connections screen is included in the standalone production application, while credentials, provider endpoints, local model servers and operator-registered MCP processes remain project/operator configuration. No live credentials, `.jevyr` store, model weights or signing keys were copied from the builder. These 12 package checks used no model inference or physical Forge execution and do not establish cloud availability, language-model quality, or cross-platform operation. The earlier strict browser failure and historical replay results above retain their original archive-specific scope.
