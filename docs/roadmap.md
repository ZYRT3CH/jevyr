# Jevyr roadmap

This roadmap is intentionally practical. The goal is to make Jevyr easier to
understand and safer to try before adding more machinery.

## Before the first public release

- Use Jevyr as the public name across commands, packages, stores, paths, and wire identifiers.
- Add a clean-clone smoke test for the documented installation.
- Add a five-minute, model-independent demo Case.
- Add screenshots from a real Case to the README.
- Add a plain-language glossary for the internal terms.
- Audit the repository for secrets, local paths, private keys, generated stores,
  credentials, and machine-specific configuration.
- Add a license and a security contact before inviting outside contributors.

## Next engineering priorities

### 1. Make the smallest useful path obvious

Create one supported path that works with a deterministic fake Mind and fake
Forge. A contributor should be able to understand the full lifecycle without
installing a large model or configuring every advanced subsystem.

### 2. Add a public example corpus

Include small, reproducible Cases with expected outcomes:

- one ACCEPT;
- one REJECT;
- one UNPROVEN;
- one INVALID.

Each example should explain the obligation, the assay, the evidence, and why the
result is not stronger than it is.

### 3. Make provider failures easier to understand

Turn common failures into direct actions:

- model unavailable;
- Docker unavailable;
- privacy setting blocks a provider;
- candidate could not be admitted;
- assay is not defined;
- evidence is incomplete.

### 4. Publish an independent verifier

Make a simple command such as 'jevyr verify ./proof-bundle' verify signatures,
event continuity, artifact hashes, and replay status without requiring a full
development checkout.

### 5. Add an agent guardrail interface

Define a small API for:

~~~text
proposed action → sealed check → evidence/test → allow, deny, or escalate
~~~

The first version should protect software agents. It should not silently turn
Jevyr into an action executor.

### 6. Add simulation adapters before hardware adapters

For robotics, begin with simulation-only integrations. A simulator should report
its version, world digest, policy, action trace, and observation digest. Physical
actuation should require a separate, explicit safety boundary.

### 7. Measure model value separately from runtime correctness

Keep two scorecards:

- whether Jevyr itself sealed, executed, recorded, signed, and replayed correctly;
- whether a connected model produced useful candidates and repairs.

The first does not prove the second.

### 8. Reduce the public vocabulary

Keep the internal names in the architecture documentation, but introduce them
gradually in the README. A new reader should understand Case, Mind, Forge,
Evidence, and Record before encountering Genome, Deep, Juggler, Bone, and Blood.

## Longer-term experiments

- A generic decision-model adapter for fast triage and escalation.
- Signed comparison reports across model providers.
- More deterministic assays for common software tasks.
- Human review workflows that preserve the no-steering boundary.
- Simulation-first validation for autonomous agents and robots.
- A small desktop installer with a guided setup and clear security prompts.
- External security review of the Forge and public transports.
