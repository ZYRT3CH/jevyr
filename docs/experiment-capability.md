# Experiment capability

`jevyr.experiment-capability/1` is the candidate-facing view of experiment
sockets already present in the sealed Assay Frontier. It is derived
deterministically from the exact Frontier and Intent Contract; a Mind cannot
add a socket, replace its argv, widen its timeout, choose a shell, provide an
environment, or author an oracle.

The first grammar is deliberately small:

- `node <portable-relative-entry>.mjs` or `.js`; or
- `python3 <portable-relative-entry>.py`.

There is exactly one argument and it is the candidate entry file. The
executable is a basename, the entry is an ASCII portable relative path, and
the sealed Forge still supplies the disposable root and physical ceilings.
A DIVERGE candidate is marked `experiment-ready` only when its compiled
blueprint contains that exact entry file and its proposal-only command exactly
matches a listed socket. The proposal never becomes execution authority: Bone
executes the separately sealed Frontier plan.

## Two authority classes

An exact socket may resolve to one command-exit obligation in the sealed Intent
Contract. That is `intent-bound` and follows the existing typed-oracle path.
Only the selected archive survivor may receive a winner-scoped support or
refutation edge, and persisted evidence must independently replay.

A socket with no obligation is `comparative-only`. Bone may execute it for the
closed candidate population and use its exact exit observation to form the
measured archive. It can embody, invalidate, retain, and rank candidates, but
it cannot satisfy or refute any Case obligation. Its evaluation deliberately
has no Intent oracle kind, and replay rejects any support/refutation edge added
to it. An explicit invalid `obligationId` fails closed rather than being
downgraded to comparative authority.

The conventional default socket is:

```json
{
  "assayId": "jevyr.experiment.node-v1",
  "costUnits": 1,
  "tool": "forge.command",
  "args": { "command": "node", "args": ["jevyr.experiment.mjs"] },
  "timeoutMs": 30000
}
```

It creates real candidate execution without silently inventing a success
criterion for a sparse human impulse. A Case can therefore produce and compare
working artifacts while its final judgment honestly remains `UNPROVEN`.

## Reflex and challenges

Reflex does not trust the authority edges already held in memory. When a first
pass finds an authority gap that persisted selected-candidate material can
resolve, it requests its single permitted repeat. Between the two reports,
Bone performs one strict replay of the persisted observation bytes, exact
Frontier, candidate population, resource receipts, Docker substrate identity,
typed oracle, and event ordering. The second report receives only the edges
reconstructed by that replay. This is evidence seeking by independent
validation, not a second model verdict and not an extra unsealed command.

The v1 lifecycle closes and executes the candidate population before the
CHALLENGE stage. Challenge and test-plan contributions in that stage therefore
remain public specifications, not executable code. Executable adversarial work
must be coevolved into a DIVERGE blueprint under a pre-sealed socket. Turning a
later challenge into a new same-Case command would require a new lifecycle and
protocol version; v1 refuses to pretend otherwise.
