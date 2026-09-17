# Jevyr Python SDK

Install the reproducible environment with `uv sync --project sdk/python --locked`.
Run the SDK tests with `uv run --project sdk/python --locked python -m unittest discover -s sdk/python/tests` from the repository root. Import the package as `jevyr`.

For a Juggler Case, `juggler_offers(case_id)` returns its current finite voucher offers, and `redeem_voucher(case_id, token)` sends exactly the selected opaque token. Both authenticate the Seal; redemption additionally checks Case/run/search bindings, the token and canonical receipt digests, and the exact scheduling effect. Sovereign Cases and closed checkpoints refuse access. See the [Juggler guide](../../docs/juggler.md) for examples and receipt verification scope.

For a Python experiment, `uv run --project sdk/python --locked jevyr-experiment experiment.py` emits a content-bound `forge.command` plan using offline `uv run`. It does not execute the submitted script on this machine. Install `uv` and any dependencies into the policy-owned OCI image before startup; that image's immutable identity and the Forge's denied-network boundary supply execution authority. A script with inline dependency metadata requires `uv lock --script experiment.py` before sealing and `--lock experiment.py.lock` when planning. Both the exact script and lock digests are included. The resulting plan becomes evidence only after the ordinary Forge has actually executed its command and persisted its observation; `uv --offline` itself is not a sandbox.

```python
from jevyr import JevyrClient

jevyr = JevyrClient()
case = jevyr.cast("Find the strongest defensible design, embody it, and judge it.")

for frame in jevyr.live_events(case["caseId"]):
    print(frame.cursor, frame.event["stage"], frame.event["kind"], frame.event["payload"])

authenticated = jevyr.authenticated_record(case["caseId"])
record = authenticated.payload
print(
    authenticated.verification,
    authenticated.verification_scope,
    authenticated.persisted_evidence,
)

# A terminal receipt is a separate DSSE-signed commitment to the complete
# terminal ledger and status projection, exact Record, and exact artifact index.
closure = jevyr.authenticated_terminal_receipt(case["caseId"])
print(
    closure.payload["lastSequence"],
    closure.payload["eventHeadDigest"],
    closure.payload["artifactIndexDigest"],
)

# Fetch the deterministic replay contract only after its canonical digest has
# been bound to the case's authenticated SealReceipt.
contract = jevyr.verified_intent_contract(case["caseId"])
print(contract["goal"]["statement"], contract["digest"])

# Editable pre-seal state; sealing binds the exact revision and startup policy.
draft = jevyr.create_draft({"case": {"impulse": "Investigate this mechanism", "control": "juggler"}})
draft = jevyr.replace_draft(draft["draftId"], draft["revision"], draft["submission"],
    choices={"preset": "wild", "sandbox": "observe_only"})
sealed = jevyr.seal_draft(draft["draftId"], draft["revision"], draft["startup"]["policyDigest"])

# A calibrated offered ball and finite quantity are the only live additions.
offers = jevyr.metabolism_offers(sealed["receipt"]["caseId"])
if offers["offers"]:
    offer = offers["offers"][0]
    addition = jevyr.redeem_metabolism(offers["caseId"], offer["ballId"], 1)
    print(addition["receipt"]["digest"])

# Emergency stop has no resume: an accepted abort closes as INVALID.
# stopped = jevyr.abort(sealed["receipt"]["caseId"])
```

`live_events` validates each `CaseEvent`'s exact discriminator-specific shape, digest, prior link, Case/run identity, and forward-only lifecycle progression. It reconnects SSE with a numeric `Last-Event-ID` and falls back to cursor-based long polling only for transport failures. Every frame says `verification_scope="event-hash-chain"`: continuity does not establish that an observation is true. `cast` and `seal_receipt` return the typed, exact-key `SealReceipt`, whose required `subjectMaterialCaptureDigest` commits to the immutable subject binding set captured before Seal. `intent_contract` validates the exact nested `jevyr.intent-contract/1` shape, compiler identity, references, impulse digest, and canonical contract digest; `verified_intent_contract` additionally requires that digest to match the cryptographically authenticated Seal.

`reproduce_case(source_case_id, "same" | "new")` requests a separate Sovereign Case from the source's authenticated stored material. It sends only the source identity and seed choice, never reposts or recaptures original locators, and authenticates both Seal receipts while comparing material, policy, Genome and search bindings. The daemon refuses sources or changed startup policy that cannot support a controlled reproduction. The client never retries this POST automatically.

`authenticated_record` verifies the signed Seal and Record with the daemon's public Ed25519 trust bundle, exact DSSE PAE bytes, canonical payload equality, one shared trusted key identity, and matching case/run/policy/Genome/search/intent provenance. `terminal_receipt` and `terminal_envelope` expose the strict closure material; `authenticated_terminal_receipt` (also available as `verified_terminal_receipt`) verifies that pair. The trust contract authorizes exactly the ordered Seal, Record, and terminal DSSE payload types.

Authentication deliberately returns `persisted_evidence="not-replayed"`: the signed Record's `verdict.integrity` is an authenticated recorded claim, not an SDK finding that persisted evidence is complete or valid. `policy_descriptor` rehashes the exact Case-bound policy descriptor; `verified_policy_descriptor` additionally binds its Case, run, and policy digests to that authenticated Record, but still does not replay evidence. Use `jevyr replay CASE_ID` where the CLI can resolve the exact policy, ledger, and content-addressed artifacts and independently replay them. `verified_record` remains as a compatibility alias for `authenticated_record`; it has the same limited scope. `record` alone performs structural validation and makes no signature claim. Cursor `0` means before the first event; sequences begin at `1`. The SDK deliberately exposes no continuation or message method after cast.

`wait_for_authenticated_record` additionally consumes the terminal public chain without lifecycle regression, proves that the Record's crystallization head is one of its prefixes, retries until the separately signed terminal closure exists, and requires the closure's Case/run identity, canonical Record digest, complete event head, final status projection, canonical artifact-index digest, and trusted key to agree exactly. The returned `AuthenticatedTerminalRecord.terminal` carries that authenticated closure and its `trace_verification` is `event-hash-chain+signed-terminal-head`; persisted evidence remains `not-replayed`, and indexed bodies are not fetched by the wait. `wait_for_record` remains the payload-only compatibility wrapper.

## Fixed production and advisory statements

`client.run_attestations(case_id)` reads the two bounded in-toto envelopes.
`client.verified_run_attestations(case_id)` authenticates their exact derived
SLSA v1 production and advisory predicates against the Seal, Record, and terminal
receipt under the same public signer. The public trust contract remains limited
to its original three payload purposes; arbitrary in-toto statements are refused.
This verifies provenance and bytes, not independent physical-evidence replay or a
SLSA level. The result explicitly records `slsa_level_claim == "none"`.

Save `verified.canonical_record.encode("utf-8")` verbatim as
`canonical-record.json` without a trailing newline. Its byte hash is the signed
statement subject; pretty-printed `record.json` has different bytes. Offline
`verify_run_attestations(payload, material)` accepts the same material keys as
the TypeScript verifier: `seal`, `record`, `terminal`, `sealEnvelope`,
`recordEnvelope`, `terminalEnvelope`, and `trust`.
