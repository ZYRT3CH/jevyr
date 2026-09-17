# Use Jevyr

Jevyr accepts one task, freezes its subjects and permissions, creates candidates,
executes the admitted experiments, and closes a signed outcome. It is not a chat.
The browser, CLI, and MCP clients share the same local daemon.

## Open the application

On Windows, open **Start Jevyr.cmd** in the repository. It changes to the correct
folder before launching. Keep its terminal open while it owns the services.

For a terminal launch, first change to the repository. In Windows Command Prompt:

```bat
cd /d "C:\Users\sondr\OneDrive\Dokumenter\--DS_JUDGE--"
pnpm jevyr up --local-model qwen3-coder:30b-32k
```

The model name must identify a model already installed in your local Ollama.
This command never downloads or enables a remote provider. An existing daemon's
model configuration is immutable: changing it requires stopping and restarting
the daemon, not editing a running case.

For another checkout, use its actual path. `pnpm jevyr ...` is a repository
script, not a globally installed command. Running it from your home folder
without a `package.json` produces `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`.

First-time prerequisites are Node.js 24+, pnpm 10+, and Docker Desktop with its
Linux engine running. In the repository:

```sh
pnpm install
pnpm build
pnpm jevyr init .
docker pull node:24-alpine
pnpm jevyr up --local-model YOUR_INSTALLED_OLLAMA_MODEL
```

Docker's image is resolved to its immutable image ID at daemon startup. The
runtime does not pull images during a sealed case. `pnpm jevyr doctor` explains
missing capacity without hiding it behind template output.

## Give it work

Open `http://localhost:3001` and choose **New case**.

1. Describe the task and what would count as evidence.
2. Choose automatic direction, creation, or audit. Attach relevant files,
   folders, or text. If the task depends on a schema or an existing implementation,
   attach it; the model should not have to invent it.
3. Select processing privacy. **Local only** is the default.
4. Select **Seal the case**. That is the last semantic input for that case.

**Observe** shows the current public activity, lifecycle, experiment results,
and resource readings. Updates arrive automatically through SSE, with verified
cursor-based long-poll recovery after interruptions. There is no pretend progress
percentage. A completed case stops producing events and is labelled completed.

**Candidates** exposes proposals, genealogy, and state changes. **Experiments &
evidence** separates observations from model reports. **Files** verifies artifact
bytes before displaying or downloading them; generated source is never executed
by the browser. **Live ledger** lets you inspect an exact event and replay its
prefix without interrupting the live observer. **Outcome** shows only an
authenticated terminal Record. **Anatomy** is an optional causal visualization
of the same trace, not a representation of hidden thoughts.

Closing the browser does not cancel a case. Reopen its case URL to observe again.
Keep the daemon running. A new task requires a new case, never a continuation of
the old seal.

## Work from the terminal

```sh
pnpm jevyr doctor
pnpm jevyr cast "Create a dependency-free parser with autonomous self-checks." --mode design
pnpm jevyr watch CASE_ID
pnpm jevyr open CASE_ID
pnpm jevyr replay CASE_ID --json
```

`watch` authenticates the Seal, complete event chain, Record, terminal closure,
and artifact inventory. `replay` additionally re-evaluates persisted evidence.
Neither command turns an `UNPROVEN` design into a proven one.

To make a local `jevyr` launcher that can be used without the `pnpm` prefix:

```sh
node scripts/install-local-cli.mjs
```

The installer prints its dedicated bin directory. Add that directory to your
user PATH, then open a new terminal. It never edits PATH itself or replaces an
existing launcher. The installation links to this checkout: keep the checkout
and its dependencies in place. This is not a standalone packaged release.

After installation, `jevyr init /path/to/project` initializes that folder. Run
`jevyr up` from the target project. You can also stay in the Jevyr checkout and
attach another folder as a subject of a case.

## Connect an MCP client

Start the daemon with `jevyr up` first. A stdio MCP client can launch:

```json
{
  "mcpServers": {
    "jevyr": {
      "command": "node",
      "args": [
        "C:/Users/sondr/OneDrive/Dokumenter/--DS_JUDGE--/apps/cli/dist/main.js",
        "mcp",
        "serve",
        "--url",
        "http://127.0.0.1:4317"
      ]
    }
  }
}
```

Change the absolute path for your checkout. Use the direct Node entry point for
stdio so package-manager banners cannot contaminate JSON-RPC.

The advertised tools are `submit`, `status`, `result`, and `evaluate`.
`submit` returns one new Case's Seal receipt immediately. `evaluate` submits
once, waits at most 30 seconds after Cast, then returns the terminal signature
bundle or that same pending receipt. Use `status` and `result` to observe it.
Both submission forms use the daemon's startup-configured Minds.

Historical tool names still work as compatibility handlers. `jevyr_run` keeps that originating MCP call
open through terminal closure and uses the client's declared Sampling
capability as the only, Case-scoped Mind. It requires explicit
`provider_scoped` or `full_case` privacy. The client chooses and reports the
model; Jevyr cannot prove that it is the host application's outer conversation
model. Sampling is a compatibility feature for MCP 2025-06-18/2025-11-25 and
is deprecated in MCP 2026-07-28.

Caller-model prompts use no ambient MCP context and no tools. New adapters have
a 90,000-token request ceiling, but the actual `maxTokens` sent is the smaller
of 90,000 and Bone's remaining sealed per-call output reservation. It is a
maximum, not a request for padding and not a guarantee that the client will
generate that many tokens. The bridge connects to the existing daemon instead
of opening a second writer on its storage. Separately configured outbound MCP
witnesses are pre-Seal capabilities; their results remain quarantined context,
not automatic verdict authority. See [operations](operations.md).

## Understand the limits of an outcome

A fresh initialization admits a finite comparative Node experiment:
`node jevyr.experiment.mjs`. The generated entrypoint must run autonomously,
without stdin, extra arguments, package installation, or network access.
Passing its own self-check is an observation, not independent proof of an
arbitrary human requirement. Judgment-capable tests must bind to the exact
sealed intent oracle. Failed, blocked, and unproven outcomes are real outcomes.

The optional `?specimen=1` route is only a labelled visualization test fixture.
Normal cases use real models, real persisted files, and the configured Forge;
they never fall back to specimen events.
