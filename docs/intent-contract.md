# Deterministic intent contract

Jevyr does not ask a model to decide what a Cast meant. Before any mind runs, Bone applies `jevyr.intent-compiler/1` to the exact submitted impulse, declared constraints, requested assays, and sealed subject identifiers. The result is an immutable `jevyr.intent-contract/1` object.

The compiler is intentionally finite and conservative. It performs whitespace normalization for derived statements, recognizes a small public grammar, and never supplies a missing path, threshold, comparator, command, domain fact, or preference. It records:

- the byte-exact impulse and its SHA-256 digest;
- the goal copied from the impulse;
- explicit constraints copied from fields or prohibitive clauses;
- kernel and explicitly stated success/failure conditions;
- unresolved ambiguity with all mechanical alternative readings left unselected;
- critical obligations and, only where the Cast states a closed predicate, a machine-addressable oracle.

Recognized oracle families are command exit code, exact output, network-access count, JSON parsing, path existence, sealed-subject immutability, sealed test-suite pass, and an explicitly requested assay. Recognition identifies the predicate; it does not count as evidence that the predicate holds.

Every other critical obligation is `UNASSAYABLE`. That is not silently repaired with a plausible metric. Bone emits `UNASSAYABLE_OBLIGATION`, Reflex reports it, and the judgment remains `UNPROVEN` unless admissible evidence decisively refutes the obligation, in which case it may be `REJECT`.

The contract digest is carried by the Seal receipt, sealed Case, verdict, Reflex, and Record. Replay receives the sealed contract, reconstructs its obligations, and checks the same digest. Replay without the contract is marked invalid rather than inferring obligations from later model claims.

The daemon exposes the canonical contract at `GET /v1/cases/{caseId}/intent-contract`. A replay client must validate its complete versioned shape and canonical digest, then require that digest to equal the independently authenticated Seal receipt. The endpoint is not continuation—it cannot alter the sealed Case—but it does contain the original Cast and is therefore a sensitive local read surface.

## Core API

```ts
const contract = compileIntentContract({
  impulse: submission.case.impulse,
  constraints: submission.case.constraints,
  requestedAssays: submission.case.requestedAssays,
  subjectIds: submission.case.subjects?.map((subject) => subject.id),
});

const input = bindIntentContract(policyInput, contract);
const verdict = compileVerdict(input);
const reflex = evaluateReflex(verdict, input, options);
const replay = replayCase(events, { policyVersion, intentContract: contract });
```

An orchestrator must publish the contract obligations by their existing IDs; it may add hypotheses, but it must not replace or rename a sealed obligation. Evidence and assays link to those IDs. Crystallization refuses a verdict whose `intentContractDigest` differs from the sealed Case.
