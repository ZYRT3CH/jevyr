# Jevyr from your terminal

Once the local launchers are installed and their directory is on your user PATH,
open a new CMD or PowerShell window in any directory:

```text
jevyr
jevyr up
jevyr doctor
jevyr watch CASE_ID --tui
jevyr mcp serve
```

Bare `jevyr` opens an interactive terminal menu. In a pipe or other non-interactive
environment it prints help instead. `jevyr` is the canonical command.
`up` opens the browser interface and starts missing services; it connects to
already-running services without changing their models or interrupting cases.

The caller's directory is the project context when starting a new runtime.
Run `jevyr init` inside a project to create its configuration. To start a new
daemon with an installed Ollama model, use `jevyr up --local-model MODEL`.
This does not reconfigure an already-running daemon.

`watch --tui` shows sealed obligations, live public claims and assays, and observed
lane commitments. Tab selects a panel; arrow keys scroll. For a Juggler Case,
numbered calibrated balls expose their scope and resource cost before a typed
quantity is sent with Enter. Sovereign observation remains read-only. Escape
cancels quantity entry; `q` or Ctrl-C closes the view without stopping the Case.

## Install from this checkout

Build the repository, then run `node scripts/install-local-cli.mjs`.
On Windows this creates both launchers in `%USERPROFILE%\.local\bin`.
Add that directory to your **user** PATH and reopen your terminal. The installer
does not alter PATH itself. Identical launchers are retained; different existing
launchers are never overwritten.

The installer deliberately avoids AppData: when run from a packaged Windows
application, AppData writes can land in private package storage and appear to
succeed while ordinary CMD cannot see the launchers.

This is a linked local installation, not a published standalone distribution:
keep the checkout and its Node runtime in place. Rebuild after source changes.

`pnpm jevyr up` is the repository development script and still needs the repository
as its working directory. Use `jevyr up` for the global command.

Case submission is one-way. The menu requests confirmation before sealing;
observing a case does not send it additional instructions. A working launcher
does not imply model readiness: `jevyr doctor` reports the actual runtime state.
