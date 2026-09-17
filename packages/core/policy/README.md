# Deterministic Rego/WASM judgment

`judgment.rego` independently computes all four verdict axes from the admitted
typed evidence projection. `judgment.wasm` is the actual OPA-compiled module used
by every `compileVerdict` call. The TypeScript reference computes the same axes
and rejects any disagreement; there is no fallback that silently bypasses Wasm.
Neither implementation receives prompt text, provider names, preferences, or
resource vouchers as judgment inputs.

The source and module SHA-256 digests are pinned in `src/policy-identity.ts` and
in the Bone descriptor. Core verifies installed bytes once at module startup.
Changing the policy therefore changes constitutional identity and requires a
compatible Genome; an already bound daemon cannot reload it during a Case.

Build with Open Policy Agent **1.8.0**, using its documented
[Wasm compiler](https://www.openpolicyagent.org/docs/wasm):

```text
opa build -t wasm -e jevyr/bone/axes -o bundle.tar.gz packages/core/policy/judgment.rego
tar -xzf bundle.tar.gz
```

The extracted `policy.wasm` is `judgment.wasm`. Keep Rego source line endings LF,
update both pinned digests after an intentional policy change, and run the core
tests. `wasm-policy.test.ts` exercises a cross-product of decisive support,
refutation, open assays, candidate failures, integrity failures, and Reflex
downgrades. The module currently requires no custom host builtins.

# Reflex observations

## Explicit original-subject policy v2

The optional `jevyr.bone/2` policy uses the separate `judgment-v2.rego` and
`judgment-v2.wasm` files. It recognizes the exact sealed
`Existing tests must pass.` purpose:
one directory subject, one recompiled critical obligation, no extra constraints
or requested assays, and the current pinned original-subject kernel. Creation
and embodiment are still computed independently; the creation prerequisite is
waived and source support can therefore
produce `FAILED / NOT_BUILT / ACCEPT` without a fabricated candidate. Only
separately admitted original-subject certificate edges judge that unchanged
subject. Generated candidate edges, candidate-scoped assay rows (including
closed populations), and candidate contradictions remain candidate assessments.
They cannot support or refute the original tests obligation. Non-candidate
critical guards and global integrity/audit rules still apply; duplicate selection
remains an unresolved coherence finding, rather than refutation of original tests.

The default `JEVYR_BONE_DESCRIPTOR` and both v1 policy files remain unchanged.
`JEVYR_BONE_V2_DESCRIPTOR` is an explicit startup selection. Historical policy
labels keep the original Wasm semantics and cannot admit original-subject edges.

`original_subject_assertions` events require a closed binding to the subject,
obligation, original capture, certificate, execution receipt and kernel. A Bone
actor may claim exactly one support or refutation edge. Projection admits it
only through the separate `verifiedOriginalSubjectEdges` tuple allowlist and
the structurally validated full original Case in `originalSubjectContext`.
The verifier host must authenticate that Case, certificate, physical execution
and Record/event membership before supplying these options. Core does not treat
the tuple or binding as a portable authority token.

Ordinary graph deserialization does not restore original-subject authority.
Display-wording probes can use `withDisplaySummaries` on an already admitted
graph; this preserves exact evidence and changes only public display summaries.
Malformed, missing, duplicate, foreign or unused authority tuples fail closed.
The new kernel does not adopt diagnostic test reports or relax formal-proof,
critical-assay, contradiction, integrity, or Reflex rules.

Compile v2 with the same pinned OPA 1.8.0 command and entrypoint shown above,
targeting `judgment-v2.rego` and a separate output archive. Never overwrite v1.

Reflex now audits coverage/provenance, provider/seed/lineage correlation,
premature convergence, terminal claims, evaluator isolation, initial-condition
anchoring, transitive memory contamination, assumption changes, and preference
wording. Each report labels each audit `passed`, `failed`, or `unmeasured`.
Absent probes or a provider's unverified seed handling are never called proof
of independence. Known provider correlation remains a disclosed measurement;
it cannot override decisive independent execution evidence.

Runtime facts use a closed `EvidencePayload.audit` receipt. Its `contentDigest`
must hash the exact receipt, its evidence type must be `tool_observation`, and
its actor must be a runtime kernel or tool. Model and peer observations cannot
mint audit authority. Lineage commitments describe the **blind first wave**;
later recombination inputs must not be mislabeled as blind commitments.

Paired wording/initial-condition probes are comparable only when they contain
one baseline and one variant with identical obligation and admissible-evidence
digests. An absent, incomplete, or mismatched pair is `unmeasured`. The runtime
must execute those probes before emitting receipts. A changed outcome for a
matched pair downgrades acceptance to `UNPROVEN`; receipts are not generated
from a model's assertion that it is invariant.

Oracle mutation, blind-input leakage, hidden assumption changes, and influential
transitive memory contamination invalidate the Case. Untested terminal claims,
premature selection, or shared builder/evaluator identity prevent acceptance.
These effects are compiled from evidence even if no Reflex report is supplied;
crystallization additionally requires the mandatory completed report. Replay
recomputes new reports and handles the first explicitly unverified authority
view before the one permitted evidence replay.

Runtime `integrity.sandbox_failure`, `integrity.provider_failure`, and
`integrity.capability_loss` kernel actions with `failed` status project to fatal
pre-judgment issues. Optional unavailable witnesses should not emit these
promised-capability failure actions.

When the closed finite candidate population has no survivor, the runtime may
emit a `closed_population` critical failed assay only after **every** admitted
member has a complete measured assay row and a decisive failed oracle bound to
a critical obligation. Persisted replay recomputes the population, each failure,
the aggregate evidence citations, and event ordering. The resulting `REJECT`
has an `ADMITTED_POPULATION_EXHAUSTED` basis. It does not attach a global
refutation edge or claim that unexamined solutions are impossible. A partial or
resource-exhausted population remains `UNPROVEN`.

Formal contradiction evidence is a separate, narrowly bounded authority. The
`jevyr.formal-counterexample/1` certificate binds a sealed obligation, its exact
statement digest and source span, a finite sequence domain, and an arithmetic
witness. For a total mapping required to shorten every finite byte or bit
string, the admitted empty input would require a negative-length output. The
checker independently reconstructs that proposition and verifies the impossible
output-length bound. The result is `FORMAL_COUNTEREXAMPLE_VERIFIED` and `REJECT`,
without minting a sandbox execution or trusting model prose.

The supported language is closed: a direct request to build/create/implement/
design/provide a mapping, encoder, or function from every finite byte/bit string
to a strictly shorter string (or one at least N units shorter), plus the explicit
form `forall input in ByteString(minLength=0): len(output) <= len(input) - N`
(`BitString` is also supported). N is a positive integer at most 999999. The
optional instruction to judge the unchanged original request does not alter
the mapping requirement. The checker requires one whole-impulse obligation and
no separately declared constraints, subjects, or requested assays. Nonempty
domains, exceptions, average/asymptotic claims, quotations, mixed units and
unknown scientific statements are outside this fragment and remain unproven.

The formal checker is pinned separately in Bone by its closed grammar/rule
descriptor and SHA-256 of the actual imported implementation file. The file is
checked again before certificate construction and verification. A replay using
a different checker is unsupported; it cannot acquire authority by preserving
the certificate text. Source TypeScript and packaged JavaScript executions have
distinct implementation identities, so use the same build conditions to replay
their proofs. Historical Cases without this descriptor have no formal-proof
authority. Their original Rego source and Wasm bytes remain unchanged.

The policy compiles verified mathematical refutations through its existing
typed refutation input, while graph evidence continues to distinguish model,
tool, and sandbox observations. The mandatory Reflex rechecks the certificate;
display-wording probes preserve the sealed statement and alter only graph
display summaries.
