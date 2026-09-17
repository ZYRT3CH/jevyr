# Jevyr threat model

Jevyr assumes that models, tools, peers, subjects, memories, and rendered content can all be wrong or hostile. Trust is granted to narrow mechanisms, not personalities or model brands.

## Assets

- the exact meaning and subject state fixed by the Seal;
- the authority boundary between contributors and the deterministic kernel;
- the append-only Blood event chain and evidence graph;
- the source tree, which the Forge must never mutate;
- private case data and provider-scoped disclosures;
- Bone, promoted Genome versions, signing keys, crystallized Records, and terminal receipts.

## Trust boundaries

Bone validates, orders, and compiles. Inner minds and remote models may only publish claims and candidates. MCP tools and A2A peers are quarantined witnesses. Deep supplies late hypothesis seeds but never evidence. Forge output becomes adjudicative only after a typed candidate × assay observation survives aggregate accounting, the measured archive closes, and Bone selects that candidate.

## Principal attacks and required posture

| Attack                                                                       | Required response                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Post-Seal prompt or approval injection                                       | No semantic endpoint exists; reject the request                                                                                             |
| Model writes `ACCEPT` or fabricates test success                             | Store it as a model report; it has no verdict authority                                                                                     |
| Event omission, reordering, or replacement                                   | Reject the sequence or digest discontinuity                                                                                                 |
| Malformed UTF-8 is normalized into the same visible ledger text              | Decode durable and network protocol bytes fatally; never hash or validate replacement-decoded text                                          |
| Record, Seal, or terminal-closure payload substituted in transit             | Require canonical-payload equality and a DSSE Ed25519 signature from one trusted key id                                                     |
| Post-Record event tail or terminal status is rewritten                       | Replay the complete event chain and require the same key to sign its exact terminal head, sequence, status projection, Record digest, and closure time |
| Artifact is injected, removed, or relabelled after terminal closure          | Sign the canonical complete artifact-index digest in the terminal receipt, forbid later artifact writes, and verify every indexed body by length and digest |
| Public key metadata lies about its identity                                  | Recompute the key id from the SPKI bytes and reject a mismatch                                                                              |
| Subject path mutates after Seal                                              | Never reread it for a run; use only captured CAS bytes and rehash the binding before projection, materialization, and Record signing        |
| Subject capture is missing or downgraded                                     | Refuse the Case rather than fall back to a mutable locator                                                                                  |
| Tool output contains instructions                                            | Treat it as untrusted data, never control flow                                                                                              |
| Candidate blueprint smuggles shell, environment, oracle, verdict, or secrets | Reject the blueprint, retain only the abstract candidate, and publish the refusal                                                           |
| Candidate command attempts to authorize execution                            | Keep it proposal-only; execute only the separately sealed policy-owned assay plan                                                           |
| Persisted blueprint claims a different or weakened ignore policy             | Recompile the exact ignore source embedded in sealed policy and revalidate every population blueprint before releasing evidence authority   |
| Early or flattering candidate tries to become the winner before measurement  | Emit raw cell evidence without support/refutation edges; select only after the complete measured archive closes                             |
| One assay cell contaminates another                                          | Reconstruct candidate and sealed subjects into a fresh root for every candidate × assay cell, then remove it                                |
| Frontier fan-out escapes the Case budget                                     | Charge aggregate wall, assay cost, workspace, artifact, and measured CPU use; if exhaustion truncates the frontier, select nobody           |
| Forge writes through HOME, temporary files, cache, or shared memory           | Force those paths into the same disposable writable envelope and include them in polling and the complete post-execution scan                |
| Sandbox unavailable                                                          | Record `not-executed`; critical claims remain `UNPROVEN`                                                                                    |
| Opaque or trusted-host adapter fabricates Docker-looking evidence             | Preserve it as diagnostic data; only the frozen built-in Docker boundary matching sealed substrate identity can mint verdict edges          |
| Mutable image field or tag changes after Cast                                 | Keep identity/configuration in private frozen state; create by immutable ID and inspect the concrete container before start                  |
| Adapter blocks the event loop past its timer                                  | Compare settlement against Bone's monotonic absolute deadline and reject the late result regardless of promise/timer ordering                |
| Candidate or assay cell is omitted from replay                                | Verify the population closure and reconstruct the complete population × frontier matrix and measured archive                               |
| Forge escapes or source changes                                              | Invalidate integrity and retain the observation                                                                                             |
| Memory anchors the first wave                                                | Retrieval is structurally unavailable before recombination                                                                                  |
| Cross-project memory leaks identifiers or content                            | Reject it in the tribunal and permit project purge propagation                                                                              |
| Origin run, duplicate exact submission, or fabricated label claims reproduction | Re-verify both signed Cases and committed fingerprints; count distinct non-origin `runDigest` values, require strict later chronology and clean lineage, and persist public comparison artifacts |
| Indirect or corrupt memory lineage hides contamination                          | Close source influences and target ancestry transitively; re-hash and re-adjudicate every bounded member; exclude missing, cyclic, incompatible, or intersecting closures                         |
| Similar prose or a changed mechanism is treated as confirmation              | Compare only exact task/material/mechanism fingerprints before exposure or evidence insertion; changed mechanisms produce diagnostic exclusions, never Tribunal edges            |
| Descendant rewrites Bone or promotes itself                                  | Reject it; only a separate governance signature can promote                                                                                 |
| Active Genome pointer changes during daemon life                             | Ignore it until restart; all Cases use the single verified startup selection                                                                |
| Genome names arbitrary code, unbounded knobs, or more resources              | Compile only exact built-in descriptors; compose every active knob in the tightening direction and seal the result                          |
| Huge attempt ceiling is interpreted as a work order                          | Treat `1500000000000000000000` as a remote safety guard; physical budgets and saturation remain authoritative                               |
| Juggler allocation steers the verdict                                        | Accept only opaque effort vouchers fixed to the sealed policy                                                                               |
| UI invents state or silently simulates a failed run                          | Refuse the event or show an explicitly labelled specimen                                                                                    |
| Pull-request subject replaces the advisory workflow or judge                   | Use the base-context `pull_request_target` definition, load Jevyr from the exact base commit into a disjoint checkout, and never run the subject checkout on the host |
| Pull request targets a weaker base branch and makes it executable authority     | Accept advisory PR runs only when the base ref is the protected, reviewed repository default branch; stronger authority remains external |
| Pull-request subject changes `.jevyrignore` to hide its own material            | Reject links and non-files and require the proposed policy's presence and bytes to match the exact trusted base; policy changes take effect only after separate review and merge |
| Pull request exploits privileged base context through subject code, cache, or secrets | Grant only `contents: read`, reference no secrets or cache, scrub build/daemon/CLI environments, and treat the separately checked-out subject strictly as captured data |
| Runtime provenance is rewritten after the Case or mixed across reruns          | Cast canonical workflow/runtime/subject and run identity as the sole second text subject, export the validated immutable Case, and require its signed snapshot digest and locator to equal the provenance bytes |
| Daemon seals a different one-shot request than the action submitted             | Precompute the normalized impulse, canonical submission, seed, intent, and clean Git snapshot commitments; require the sealed Case to equal every expectation before export |
| Live export validates but upload publishes different bytes                        | Finalize and verify the closed directory, package one normalized tar, verify its extraction, upload only that file, then download it, match its pre-upload SHA-256, and independently verify the downloaded extraction before the job succeeds |
| Huge or deeply nested checkout exhausts the manifest verifier before its nominal cap | Enforce path-count, path-byte, leaf, directory, visited-node, and logical-byte ceilings incrementally while parsing and walking; stop at the first over-limit element |
| Uninitialized gitlink is mistaken for captured repository content                  | Parse commit-tree modes before capture and reject mode `160000` explicitly while submodule bytes are absent                              |
| Empty runtime or authority directory appears, disappears, or changes mode unnoticed | Inventory and bind every non-Git directory, including empty ones, and distinguish an absent `.jevyr` namespace from a present empty namespace |
| A checksum manifest or self-contained per-run key is mistaken for external authenticity | Treat the manifest as corruption detection and the bundled key as internal consistency only; offline authority must pin an expected key ID/artifact digest from authenticated transport or an external trust root |
| Merged change weakens the in-repository advisory workflow for future runs      | Do not call that workflow merge authority; a required decision needs a workflow and authenticated trust root pinned outside the judged repository               |

## Failure posture

Integrity failure is not a generic exception hidden from the Record. When durable storage remains available, Jevyr publishes the failure, compiles `INVALID / FAILED / FAILED / NOT_APPLICABLE`, signs the terminal account, and stops. If the ledger or key store itself cannot be trusted, it must fail closed and must not synthesize a valid Record.

Remote binding, trusted-host execution, Forge networking, mutable repository credentials, automatic patch application, deployment, and merge authority are all opt-in operator decisions. None is a consequence of casting a Case.

The repository advisory's direct manifests detect source, subject, and generated execution-tree drift without trusting post-build Git metadata. They are not privilege separation: package downloads, the compiler/build toolchain, pinned setup actions, and the hosted runner remain infrastructure trust, and arbitrary hostile code running as the runner user could attack both a checkout and its guard state. Treating that toolchain as hostile requires a separate builder, a read-only source mount, independently transferred digests, and execution in a distinct verifier boundary.

The loopback trust endpoint distributes only the active public verification key. It does not expose a private key, a private-key path, or an API that signs arbitrary caller data. For a remote daemon, obtaining both data and trust keys through the same unauthenticated channel is vulnerable to substitution; key pinning or authenticated transport remains an operator requirement.
