# Airlock, controlled reruns, and team access

Open `/airlock` in Chamber to create an editable draft. Saving generates a 256-bit seed when none was provided and returns inferred obligations, ambiguities, the startup Genome, configured capabilities, and exact resource ceilings. A later revision can remove capabilities, lower ceilings, select observe-only execution, or choose Wild to remove preset restrictions for that draft. It cannot expand project authority. Open `/genome-lab` to inspect the bound strategy, selected paired benchmark, and quarantined offspring requests.

`judge airlock [path]` starts the configured local app and opens Airlock with that plain file or directory prefilled. Omitting the path uses the current project. The URL does not save a draft, choose a mission, disclose credentials, or seal a Case. `--no-open` only prints the editable URL and starts no processes. `--url` and `--chamber-url` select explicit daemon and browser addresses. For a source directory literally named `create`, `show`, `edit`, or `seal`, use its path form, such as `./create`.

Seal accepts the exact saved revision and preview policy digest. A stale revision, changed policy, duplicate admission, or attempted edit after sealing is rejected. An uncertain admission closes that draft permanently rather than risking a second Cast. Airlock defaults to local-only disclosure and Juggler control; Sovereign remains available for controlled runs. Normalized seed and all choices are bound before any investigator runs.

The CLI accepts a normal Case submission or the following wrapper with optional draft choices:

```json
{
  "protocol": "jevyr.airlock-input/1",
  "submission": {
    "protocol": "jevyr.case/1",
    "case": {
      "impulse": "Investigate this finite question.",
      "privacy": "local_only",
      "control": "sovereign"
    }
  },
  "choices": {
    "preset": "wild",
    "sandbox": "observe_only",
    "resourceCeiling": { "maxForgeWallMillis": 0 }
  }
}
```

```powershell
pnpm judge airlock create --file case.json --json
pnpm judge run --case case.json
pnpm judge watch --tui case_IDENTIFIER
pnpm judge abort case_IDENTIFIER
```

`airlock show`, `airlock edit --revision N --file case.json`, and `airlock seal --revision N --policy-digest sha256:...` support separate review and sealing. A supplied Airlock seed is exactly 64 lowercase hexadecimal characters. Bare Cast retains its existing seed contract.

`judge replay CASE` verifies the existing proof. `judge replay CASE --same-seed` or `--new-seed` creates a new controlled Case after authenticating the closed source. It reuses verified captured bytes, not the mutable original path, and preserves the original Chamber mode. Startup policy, Genome, search permissions, and original draft choices must still match. Before late recall, the rerun compares admitted memory payloads against the signed original Record; changed memory produces INVALID before any hint is used. A new seed intentionally changes seed-dependent identity. Provider responses and physical timing may remain nondeterministic. Neither rerun command mutates or resumes the original Case.

Juggler execution reproduction requires the source policy's `jevyr.metabolic-checkpoints/1` marker and its complete signed admission trace. Same-seed requires exact semantic checkpoints and original kind/quantity order. New-seed intentionally changes the investigation trajectory: it reissues each original addition, in order, at the first eligible checkpoint in the original stage. This rule is deterministic and policy-bound; it does not claim the same timing or candidate trajectory. Every addition has a fresh run-bound receipt and must fit a current calibrated offer and the original separate allowance. Controlled reruns refuse extra live doses. An unavailable matching effect, changed same-seed context, or incomplete replay closes INVALID. Historical checkpointless Juggler Cases remain inspectable but cannot be execution-rerun by guessing their old timing.

For a shared daemon, resolve one explicit bearer-token reference at startup. For example, in the PowerShell process that will start the daemon:

```powershell
$env:JUDGE_TEAM_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:JEVYR_HTTP_TOKEN_REF = 'env:JUDGE_TEAM_TOKEN'
pnpm --filter @jevyr/daemon start
```

The CLI resolves the same reference for HTTP requests. TypeScript and Python clients accept an Authorization header; Chamber's connection panel keeps its token in page memory. Tokens are never Case fields, prompts, URLs, or ledger entries. The daemon retains a fixed hash for constant-time comparison. Remote binding additionally requires `JEVYR_ALLOW_REMOTE_BIND=1` and an explicit `JEVYR_HOST`; token authentication is mandatory for that mode. This is a shared daemon access boundary, not per-user roles or tenant isolation. Health and CORS preflight remain public; Case, artifact, Airlock, MCP, and A2A surfaces require authorization when configured.

After sealing, only authenticated reads, offered Juggler ball IDs with finite quantities, and emergency abort are accepted. Abort closes as INVALID and cannot resume. Sovereign has no metabolic admission. New semantic information always requires a new Case.
