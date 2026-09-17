# New local projects

Run `judge init PATH` to create the five portable files: `.jevyr/config.json`, `.jevyr/policy.json`, `.jevyr/assay-frontier.json`, `.jevyr/.gitignore`, and `.jevyrignore`. New policy files select Bone v2. The default configuration uses local-only privacy and Juggler control, with a finite Node experiment frontier.

Ordinary initialization preserves every existing file byte-for-byte, including a Bone v1 policy. It fills missing files; it does not migrate an existing policy. `judge init PATH --force` explicitly replaces all five initialization targets with current defaults, including any custom policy, configuration, frontier, and ignore rules. It does not erase other project files. Embedded daemon and core defaults remain compatible with Bone v1.

Initialization copies no Cases, signing keys, memory, Genome governance state, model credentials, or metabolic calibration from another project. A fresh project has no calibrated Juggler additions to offer. Baseline investigation can run; an addition becomes available only after a matching calibration has been independently verified and installed for the exact loaded implementation. Selecting Juggler does not claim that calibration exists. See [calibration scope](metabolism.md).

Bone v2 adds the narrowly bounded original-source assertion route described in [repository evaluator authority](repository-evaluator-authority.md). It does not make arbitrary existing tests or model reports authoritative. Unsupported evidence stays `UNPROVEN`; a missing secure executor does not enable host execution.

Run `judge up` from the initialized project directory to start the built production Chamber and daemon on the configured loopback origins. A source checkout needs the compiled CLI and Chamber assets first; the launcher reports missing assets and does not start a development compiler. Use the explicit development scripts when developing. Model services, OCI engines and any calibration remain separately configured dependencies.
