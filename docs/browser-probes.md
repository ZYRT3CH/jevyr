# Sealed browser experiments

Browser probes run inside the same disposable, network-denied OCI Forge as command assays. Playwright and its evaluator live in the startup-pinned image, outside the candidate's writable files. The probe accepts only a finite sequence of `click`, `fill`, `assert-text`, and `assert-count` steps, with at least one assertion. It accepts no evaluator JavaScript.

Build the evaluator image before starting the daemon:

```bash
docker build -t jevyr-browser:1 -f scripts/browser-forge/Dockerfile scripts/browser-forge
```

Set `forge.dockerImage` to `jevyr-browser:1` in the project's `.jevyr/policy.json`, then restart that daemon. Startup resolves the tag once and seals its immutable image ID. Building a different image does not change cases accepted by an already-running daemon.

The image precomputes its font caches and uses an image-owned [Fontconfig configuration](https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-user.html). This avoids per-case cache hardlinks crossing Forge's strict writable-file boundary. The file boundary remains enforced for browser experiments.

The runtime helper creates a pre-Cast assay:

```ts
import { browserProbeAssay } from '@jevyr/runtime';

const plan = browserProbeAssay({
  protocol: 'jevyr.browser-probe/1',
  entry: 'index.html',
  steps: [
    { action: 'assert-text', selector: '#count', expected: '0' },
    { action: 'click', selector: 'button' },
    { action: 'assert-text', selector: '#count', expected: '1' },
  ],
}, exactSealedObligationId);
```

Persist the returned plan in `jevyr.assay-frontier/1` before Cast. Its command is `node /opt/jevyr/browser-probe.mjs <encoded-spec>`. The exact argv must bind to a command-exit obligation in the sealed intent contract; a browser screenshot by itself cannot satisfy a broad claim such as “this interface is usable.” Candidate blueprints supply the HTML and its assets. A loopback server serves only bounded, regular files inside that candidate root; external requests and service workers are blocked.

Each measured cell exports `jevyr.browser.observation.json`, a Playwright trace ZIP, and a screenshot when available. The observation binds the probe specification, action results, loaded source hashes, runtime script hashes and coverage ranges, and trace/screenshot hashes. Coverage is attribution of observed execution, not evidence of causal necessity; `attributionIsCausation` is explicitly false. Trace and screenshot capture are attempted on assertion failures too. Forge hashes and stores these bodies in the signed case artifact inventory.

Run the reproducible local demonstrations in private stores:

```bash
pnpm proof:lifecycle browser-accept
pnpm proof:lifecycle browser-reject
```

These use deterministic candidate fixtures. They establish browser execution and adjudication, not model quality. Each exports the three signatures, terminal ledger, policy, and all artifact bytes for independent replay. The [measured evidence guide](../benchmarks/README.md) describes verification and the separate local model experiments.
