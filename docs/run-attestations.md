# Local production and advisory attestations

New terminal commitments produce two Ed25519 DSSE statements with `payloadType: application/vnd.in-toto+json`:

- Production: `predicateType: https://slsa.dev/provenance/v1`.
- Advisory conclusion: `predicateType: urn:jevyr:advisory-verdict:v1`.

Both use the [in-toto Statement v1 envelope](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md). Production follows the [SLSA build provenance v1 format](https://slsa.dev/spec/v1.2/build-provenance), with `buildDefinition` and `runDetails`. This is a format and local provenance claim, **not a SLSA build-level certification**, independent hosted builder, Sigstore transparency entry, or claim of reproducible model behavior.

The subject is exactly `canonical-record.json`: the Record encoded as Jevyr canonical JSON, UTF-8, with no trailing newline. Its SHA-256 digest equals the terminal receipt's `recordDigest`. Pretty-printed `record.json` is retained for review but has different bytes and is not the named production subject.

`urn:jevyr:local-case-lifecycle:v1` means the local sealed Case lifecycle and its canonical Record serialization. The external parameters are the sealed Case and intent-contract commitments. Internal parameters identify policy, Genome and search physics. Dependencies use content-addressed URNs for those descriptors, captured material, evidence, event head, artifact index and terminal receipt. They expose no original subject locator, host path, credential or model message. These are logical digest references; an event-head digest does not claim to be a hash of a pretty-printed `events.json` file. Material unavailable for external reproduction remains unavailable; these references do not invent source access.

The builder ID is `urn:jevyr:local-builder:<SPKI-key-digest>`, identifying the local repository signer and its host trust boundary. The invocation ID is the exact run digest. Start and finish times are the authenticated Seal and terminal lifecycle times. The advisory predicate separately copies the four recorded axes and binds the evidence and closure roots. Its authority is advisory, enforcement is none, and no SLSA level is asserted.

Only the existing Bone-authorized terminal commitment derives and signs these fixed statements. There is no caller-provided predicate, generic signing endpoint, approval route, or governance authority. Both signatures are persisted together in `run-attestations.json` before publishing the terminal receipt pair. The sidecar is excluded from the artifact inventory so its terminal-root reference cannot create a circular digest.

`GET /v1/cases/:id/attestations` returns the closed sidecar. `JevyrClient.verifiedRunAttestations(caseId)` verifies the three original signatures, derives the expected statements, checks their exact canonical payloads and verifies the two additional signatures under that same authenticated identity. Its returned `canonicalRecord` string can be saved verbatim as the subject file. The original public trust bundle still lists exactly Seal, Record and terminal payload types; the purpose-specific verifier does not authorize arbitrary in-toto or governance statements.

CLI local proof exports include `canonical-record.json` and `run-attestations.json`. Offline verification hashes the actual subject bytes, checks both signatures and rederives both predicates. New sealed policy includes `runAttestations: "jevyr.run-attestations/1"`, making missing sidecars detectable even when both files are deleted. Old unmarked three-envelope proofs remain historical evidence and are not retroactively signed. A present partial, corrupt or mismatched sidecar fails verification.
