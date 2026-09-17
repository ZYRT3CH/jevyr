# Jevyr protocol

## Canonical cast

The smallest valid submission is UTF-8 JSON:

```json
{
  "protocol": "jevyr.case/1",
  "case": {
    "impulse": "Find a mechanism that survives its strongest test."
  }
}
```

The full case may include `mode`, `subjects`, `constraints`, `requestedAssays`, `privacy`, `control`, and `seed`. A subject is `{id, kind, locator}` with optional `revision` and `mediaType`; kinds are `git`, `directory`, `file`, `url`, `text`, and `artifact`. `control` is `sovereign` by default or `juggler` when the local scheduler may consume only server-issued opaque effort vouchers.

`POST /v1/cases` is the only semantic write. No `continue`, `message`, feedback, approval, or verdict endpoint exists after the Seal.

## Digest identities

- `submissionDigest` binds the received canonical submission.
- `subjectMaterialCaptureDigest` binds the exact immutable subject-material binding set captured before Seal, including declaration-only entries; it is required on both the sealed Case and signed Seal receipt.
- `caseDigest` binds normalized intent, the intent contract, frozen subject snapshots, and the subject-material capture commitment.
- `intentContractDigest` binds the byte-exact impulse, deterministic goal/constraints/outcome conditions, unresolved interpretations, and critical oracles compiled before any mind runs.
- `runDigest` binds the case to its seed, policy, Genome, search envelope, and recorded Seal time; repeated executions retain the same `caseDigest` but receive distinct run identities.
- the effective `policyDigest` binds the complete canonical `jevyr.assay-frontier/1`, including its copied aggregate limits, effective archive controls, and ordered assay plans; it also binds the compiled Genome profile and composed runtime-growth-policy digests when present.
- each `eventDigest` binds the canonical event; `priorDigest` forms the append-only chain.
- the Record binds the `eventHeadDigest` of its verified crystallization prefix and the `evidenceDigest`; later lifecycle events extend the same chain.
- the separately signed terminal receipt binds the complete final event head and sequence, exact terminal status projection, canonical Record digest, and digest of the complete canonical `jevyr.artifacts/1` index.

Digests use canonical JSON and SHA-256, rendered as `sha256:<lowercase hex>`. Event sequences start at **1**. Cursor **0** means “before the first event.”

The capture digest binds ordered subject IDs, kinds, snapshot digests, availability, manifest digests, and byte lengths. It does not expose private bytes. A materialized binding resolves to verified manifest and blob objects; a declaration-only binding deliberately resolves to no bytes. Missing or mutated binding state is an integrity failure, not a reason to return to the original locator.

## Candidate events

`candidate.status` carries a stable `candidateId`, lifecycle status, summary, optional feasibility, optional `parentIds`, and optional artifact digests. For genealogy, omission of `parentIds` means undisclosed ancestry; an empty array declares a root. Parent IDs must be unique and a candidate cannot name itself as its parent. This field records declared lineage and does not itself prove acyclicity, feasibility, or correctness.

A model-originated candidate blueprint is not a new control message. Jevyr compiles its narrow file-and-optional-argv shape during DIVERGE, publishes the resulting blueprint and artifact digests, and erases the untrusted source object from the admitted contribution. The optional argv is labelled `proposal-only`; only an assay plan already bound into sealed policy can execute. The finite blueprint population closes with DIVERGE.

Every admitted blueprint is evaluated against the canonical ordered Assay Frontier. Each candidate × assay cell has stable candidate and assay identity; every executable cell receives a fresh disposable materialization root, while a blocked cell records why no root or process was authorized. Its first `evidence.observed` and `assay.status` events are comparative: they carry no global support/refutation edge and are never critical. After the complete measured archive closes, `candidate.status: survived` reflects only final archive membership, and at most one survivor receives `candidate.status: selected`. Bone then emits separate selected-candidate evidence with `supports` or `refutes` links to the already sealed obligation. No selected event is valid before that closure.

For `sandbox_execution`, `contentDigest` addresses the exact canonical `application/vnd.jevyr.tool-observation+json` artifact. A single observation may contain at most 2 MiB and the Case may persist at most 64 MiB of unique observation bytes. These are constitutional evidence-store limits, not candidate-controlled artifact settings. Crystallization independently rehydrates each addressed observation and repeats the typed evaluation; an event without matching durable bytes cannot carry authority.

The default `attemptSafetyCeiling` is the decimal string `1500000000000000000000` (1.5 × 10²¹). Protocol validation treats it as a positive integer guard of at most 128 digits. It does not enlarge any numeric resource field or require the runtime to approach that count. Evaluated search work consumes positive integral effort units, preventing a fractional meter from ceasing to advance beneath a remote guard.

## HTTP resources

| Method and path                              | Meaning                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `POST /v1/cases`                             | Normalize, snapshot, seal, return receipt and links                |
| `GET /v1/trust`                              | Versioned public Ed25519 trust bundle; never private key material  |
| `GET /v1/cases/{id}`                         | Derived live status only                                           |
| `GET /v1/cases/{id}/events?after=N&waitMs=M` | Cursor page or bounded long poll                                   |
| `GET /v1/cases/{id}/events/stream?after=N`   | SSE stream, resumable with `Last-Event-ID`                         |
| `GET /v1/cases/{id}/seal`                    | Canonical Seal receipt payload                                     |
| `GET /v1/cases/{id}/seal/envelope`           | DSSE envelope authenticating the Seal receipt                      |
| `GET /v1/cases/{id}/intent-contract`         | Canonical input contract whose digest is authenticated by the Seal |
| `GET /v1/cases/{id}/record`                  | Canonical crystallized Record payload; unavailable before `SIGN`   |
| `GET /v1/cases/{id}/record/envelope`         | DSSE envelope authenticating the Record payload                    |
| `GET /v1/cases/{id}/terminal`                | Canonical terminal-receipt payload; unavailable until closure      |
| `GET /v1/cases/{id}/terminal/envelope`       | DSSE envelope authenticating the terminal receipt                  |
| `GET /v1/cases/{id}/artifacts`               | Canonical content-addressed artifact index                         |
| `GET /v1/cases/{id}/artifacts/{artifactId}`  | Indexed artifact bytes with identity headers                       |

The daemon binds loopback unless an operator makes an explicit remote-bind decision. Responses disable caching. Cross-origin access is restricted to configured or loopback origins.

## Live continuity

SSE sends the event sequence as its `id`. A consumer persists its last complete cursor and reconnects with both `after` and `Last-Event-ID`. If SSE fails repeatedly, it requests the polling endpoint from the same cursor. A consumer must reject:

- a sequence other than `cursor + 1`;
- a changed `caseDigest` or `runDigest`;
- a `priorDigest` that differs from the accepted head;
- an event with unknown or discriminator-incompatible fields;
- an `eventDigest` that does not match canonical event content;
- a transition back to an earlier lifecycle stage.

Polling and SSE must yield byte-equivalent canonical events and the same head digest. Heartbeats carry no state and do not advance the cursor.

The TypeScript and Python SDKs expose the bare transport payloads as well as `trustBundle`/`trust_bundle`, `sealEnvelope`/`seal_envelope`, `recordEnvelope`/`record_envelope`, `terminalReceipt`/`terminal_receipt`, `terminalEnvelope`/`terminal_envelope`, `verifiedSealReceipt`/`verified_seal_receipt`, `verifiedIntentContract`/`verified_intent_contract`, `policyDescriptor`/`policy_descriptor`, `verifiedPolicyDescriptor`/`verified_policy_descriptor`, the explicitly scoped `authenticatedRecord`/`authenticated_record`, and `authenticatedTerminalReceipt`/`authenticated_terminal_receipt`. The policy-descriptor methods first rehash the exact Case-bound descriptor; their verified variants also bind its Case, run, and policy identity to an authenticated Record. The older `verifiedRecord`/`verified_record` names remain compatibility aliases; Python also retains `verified_terminal_receipt` as a compatibility spelling for `authenticated_terminal_receipt`. An authenticated Record result proves canonical DSSE bytes, a trusted Ed25519 signature, and identity agreement with the independently signed Seal; it always reports persisted evidence as `not-replayed`. `waitForAuthenticatedRecord`/`wait_for_authenticated_record` goes further: it consumes the exact complete public chain without lifecycle regression, proves that the Record head is one of its prefixes, authenticates the terminal receipt under the same trusted key, and requires that receipt to equal the final status projection and bind the canonical Record and artifact-index digests. It still does not replay evidence or fetch every artifact body. The existing `waitForRecord`/`wait_for_record` methods remain payload-only wrappers over that stronger wait. Live frames report `event-hash-chain` as their verification scope; the authenticated wait reports `event-hash-chain+signed-terminal-head`. None of these results establishes evidence truth. Artifact-list and artifact-fetch methods enforce the strict metadata schema and Case membership; artifact fetch additionally checks response headers, byte length, and a locally recomputed SHA-256 identity before returning verified bytes. Neither SDK contains a continuation method.

## MCP and A2A

The stdio MCP discovery surface advertises:

- `submit` — one complete new Case through the sole semantic Cast operation;
- `status` — live status/cursor polling;
- `result` — the exact three-envelope terminal signature bundle;
- `evaluate` — one Cast followed by at most 30 seconds of reads, returning the existing receipt if pending.

No tool accepts post-seal semantic input. Historical `jevyr_*` handlers remain
available for existing integrations, including the explicitly negotiated client
sampling bridge, but are absent from new tool discovery.

A2A peers receive one sealed assignment and may return public contributions once. They cannot reopen the case. MCP and peer content is quarantined data until a policy-owned assay produces admissible evidence.

## Memory Tribunal boundary

The running Case stages at `MEMORY_TRIBUNAL` only the canonical candidate already committed in its signed Record prefix; it cannot testify that it reproduced itself. Its terminal path then authenticates the normal Record, signed Seal, complete event chain, terminal receipt, and exact closure identity before comparing that run with older staged project memories. There is intentionally no endpoint for posting model assertions or arbitrary reproduction labels.

Automatic project memories carry a closed `jevyr.memory-reproducibility/1` fingerprint. Comparability is exact: intent-contract plus subject-material-capture identity, then policy, Genome, seed-independent Search profile, and Assay Frontier identity. The outcome signature is the four axes, selected feasibility, sorted feasibility multiset, and sorted basis-code multiset. A changed mechanism is excluded rather than mislabeled a contradiction. Only an exact clean later comparison yields `REPRODUCTION`; a different outcome under the same exact task and mechanism yields `COUNTEREXAMPLE`.

Each durable `jevyr.memory-evidence-observation/1` binds both `sourceCaseDigest` (content identity) and `sourceRunDigest` (execution identity) to a public content-addressed reconciliation artifact. Exact repeat submissions can share a case digest, so Tribunal independence is counted by distinct non-origin run digests. The runtime also verifies project equality, later chronology, distinct committed memory identity, and Record/envelope/event-head/evidence bindings. Its `jevyr.memory-lineage/1` contamination proof closes every source Record influence and target ancestor transitively, caps the fixed point at 1,024 unique members, and binds the sorted membership plus independently re-derived admission state. The source closure must be disjoint from the target memory and its verified ancestry. Any missing, malformed, cyclic, over-limit, incompatible, or unverifiable member excludes the comparison. Two later source runs are still required. Batch append, snapshot derivation, and terminal adjudication are atomic and exact retries re-derive the sealed state; exclusions remain public diagnostics without evidence authority.

## Record

The Record payload contains the four-axis verdict, evidence binding, required reflex result, material memory influences, crystallization-prefix head digest, case/run identity, and policy/Genome/search/intent provenance. Its signature is transported separately in a DSSE envelope so the canonical payload stays byte-identical wherever it is stored.

The Record is not the terminal transport head. `SIGN`, `MEMORY_TRIBUNAL`, and `TERMINATE` extend Blood after its crystallization prefix. Once the final status and ledger agree, Bone writes a separate exact-key `jevyr.terminal/1` receipt and signs its canonical bytes as `application/vnd.jevyr.terminal+json`. That receipt contains the terminal lifecycle, stage and stage status, final sequence and event-head digest, canonical Record digest, canonical complete artifact-index digest, and closure time. The Seal, Record, and terminal envelope must authenticate under the same trusted key.

Each advertised trust key authorizes exactly the ordered payload-type tuple `application/vnd.jevyr.seal+json`, `application/vnd.jevyr.record+json`, and `application/vnd.jevyr.terminal+json`. A missing, reordered, duplicated, or extra payload type is invalid trust material.

The canonical artifact index is `{protocol:"jevyr.artifacts/1", caseId, artifacts}` with its strict ordered metadata. A terminal receipt authenticates that exact list, not merely the artifacts referenced by the Record. New artifact bytes are refused once the Case status becomes terminal or closure material exists. An exact retry of already committed content may return its existing content-addressed metadata, but it does not mutate the inventory. Once terminal receipt material exists, status is closed as well. Artifact bodies remain independently verifiable through their indexed SHA-256 digest, size, media type, Case identity, and response headers.

Record authentication must check the expected Jevyr payload type, decode strict base64 and UTF-8, require that the decoded JSON re-canonicalizes to the exact signed bytes, match those bytes to the bare endpoint payload, verify Ed25519 over DSSE PAE, and accept only a key id whose advertised public bytes hash to that id. It then binds the Record’s case, run, policy, Genome, search, and intent digests to the independently signed Seal. Structural parsing alone is never signature verification. This authentication still does not make the Record's `integrity: VALID` field an independently established fact.

Complete authenticated replay is a separate, stronger operation. It first verifies the three signed payloads and the terminal receipt's exact final status projection, ledger, Record, and artifact-index bindings. It then proves that the Record's `eventHeadDigest` occurs in the full terminal chain, loads the exact authenticated policy and IntentContract, resolves every required content-addressed artifact, independently re-evaluates persisted evidence, and reproduces the deterministic verdict. A missing resolver, missing artifact, unsupported evidence substrate, or incomplete replay produces an incomplete/invalid result—never `VALID` by inheritance from a signature.

`GET /v1/trust` is safe to publish because it contains only SPKI public PEM. On the default loopback boundary it supplies the active verification key. Fetching a key from an untrusted remote origin is not independent authentication of that origin; remote deployments must pin the key id or protect trust distribution with an authenticated channel. CI may additionally attach Sigstore/in-toto provenance; external signatures supplement rather than replace the local evidence binding.

The sealed Case contains the canonical intent contract. The Seal receipt, verdict, Reflex, and Record repeat its `intentContractDigest`; disagreement is an integrity failure. An obligation without a truth-conditional oracle is explicitly unassayable and cannot compile to `ACCEPT`.

Replaying the same event graph under the same policy and the exact digest-bound IntentContract must compile the same verdict. An event ledger alone cannot safely reconstruct sealed obligations, so replay without that contract is invalid. Re-executing stochastic minds may produce a different run and therefore a different `runDigest`; that is comparison, not replay.
