# Model and MCP connections

The Connections page separates model providers from MCP integrations. A model
listing means an endpoint answered a discovery request; it does not mean that
model has completed a Judge investigation. A saved profile becomes active at the
next daemon startup. The page shows the active selection separately, and a sealed
Case keeps its original provider, transport, disclosure policy and resource limits.

## Choose local or cloud models

For Ollama, use its running OpenAI-compatible endpoint, normally
`http://127.0.0.1:11434/v1/`. For LM Studio, use the endpoint shown by its local
server, commonly `http://127.0.0.1:1234/v1/`. Listing models sends a bounded model
discovery request; it does not install a model or generate text. Choose an exact
returned model ID and an investigation transport supported by that endpoint.

`native` exposes Judge's permitted context functions. `structured` requests the
closed JSON context-request format without native function definitions. Both
apply the same source-read receipts and final contribution checks. Model listing
does not test either output contract. See [investigator configuration](agent-providers.md)
for the measured provider results and detailed harness configuration.
The optional model-family declaration is preserved when saving a profile. It
records the configured lineage used by correlation checks; it is not independent
proof of a provider's training lineage.

A cloud connection uses an OpenAI-compatible API base URL and a credential from
the daemon's operator-supplied catalog. The browser selects an opaque credential
ID; it never supplies a raw key, environment reference, command, or custom header.
Each credential is bound to one exact destination origin. Remote disclosure must
be enabled for that connection and permitted by the Case's privacy policy.

The daemon already recognizes `openai-env` when the operator supplies
`OPENAI_API_KEY`; this ID is bound to `https://api.openai.com`. For another
compatible provider, the operator can create `.jevyr/connection-credentials.json`
or point `JEVYR_CONNECTION_CREDENTIALS_FILE` at a credential-reference file:

```json
{
  "protocol": "jevyr.connection-credentials/1",
  "credentials": [{
    "id": "team-model-api",
    "label": "Team model API",
    "origin": "https://model-api.example.com",
    "reference": "env:TEAM_MODEL_API_KEY"
  }]
}
```

Replace the example origin with the provider's actual API origin and arrange
for the named variable to be supplied to the daemon process by the existing
secret manager. The file stores a reference, never its value. Restart the
daemon to load this catalog, then select its ID in the Connections page. A missing
variable appears as unavailable; the daemon does not silently try an anonymous
remote request. The `environment-compatible` entry, when present, describes the
already configured compatible-provider credential and its exact origin.

Saving records a versioned profile in the project's `.jevyr/connections.json`.
The revision prevents a stale browser tab from overwriting a newer profile.
Restart the daemon you started, then confirm that the active profile matches the
saved selection before sealing a new Case. Existing Cases cannot acquire new
models through these settings.

This profile manages compatible HTTP models. Existing Codex and Claude native
agent harnesses, configured stdin adapters, and peers remain configured through
their startup environment and appear in ordinary readiness. Saving replaces
only the HTTP selection. An empty HTTP selection uses the template fallback
only when no other investigator remains.

The TypeScript SDK exposes the same controls:

```ts
const view = await client.connections();
const listing = await client.connectionModels(connection);
const next = await client.saveConnections(view.revision, profile);
const witness = await client.testMcpConnection("project-reference");
```

The methods use `GET /v1/settings/connections`, `PUT` on that same route,
`POST /v1/settings/connections/models`, and
`POST /v1/settings/connections/mcp-test`. Writes include only the exact revision and
secret-free profile; discovery requests include a model selection or registered
MCP ID. They use the configured HTTP authentication, accept an optional abort
signal, and never retry a failed mutation. Closed response validation and a
one-MiB body limit apply. Active profile digests check metadata consistency;
they do not authenticate a Case or grant evaluator authority.
Settings requests require a real loopback connection. Mutations also require
the configured application origin; browsers send their own `Origin` header.
An authorized local script using the SDK must supply that exact origin through
its client headers in addition to any team token. The SDK does not invent an
origin or relax the daemon's access check.

## Use Judge from an MCP client

This direction makes **Judge an MCP tool server**. It does not add the client's
model to Judge's configured investigators. Start the Judge daemon, then configure
the MCP client to launch this stdio bridge:

```json
{
  "mcpServers": {
    "ds-judge": {
      "command": "node",
      "args": [
        "C:/absolute/path/to/DS_JUDGE/apps/cli/dist/main.js",
        "mcp", "serve", "--url", "http://127.0.0.1:4317"
      ]
    }
  }
}
```

Replace the absolute checkout path with the installed build location. Direct
Node invocation keeps package-manager output out of the stdio protocol. With the
installed command available, the equivalent command is
`judge mcp serve --url http://127.0.0.1:4317`.

The advertised tools are `submit`, `status`, `result`, and `evaluate`. `submit`
casts one complete Case and returns its Seal receipt. `evaluate` also casts only
once, then waits at most 30 seconds; a pending result includes the same receipt.
Continue observing that Case with `status` and `result`, rather than submitting
it again. The terminal result contains the three DSSE envelopes and public trust
material. There is no post-Seal message, continuation, approval, or verdict tool.

The bridge uses the daemon's HTTP authentication. When configured, its process
must receive `JEVYR_HTTP_TOKEN_REF=env:YOUR_HTTP_TOKEN_VARIABLE` and that named
token from the operator's secret manager. The token itself is not part of the
MCP arguments or Case. The bridge connects to the existing daemon and does not
start a second store writer. The implemented MCP versions are `2025-06-18` and
`2025-11-25`.

## Let Judge consult external MCP witnesses

This direction makes **Judge an MCP client**. The Connections page can select
server IDs that the operator registered at daemon startup. It cannot enter an
executable, argument list or an arbitrary tool request. Testing a registered
server initializes it and lists its tools; it does not run its configured
witness calls. A successful discovery does not by itself establish that every
configured tool is available or that a later invocation will succeed.

The operator registers witnesses with `JEVYR_MCP_WITNESSES_FILE`. A minimal
configuration has this form; the executable, tool and argument names must match
the server being installed:

```json
{
  "protocol": "jevyr.mcp-witnesses/1",
  "servers": [{
    "id": "project-reference",
    "displayName": "Project reference",
    "command": "C:/absolute/path/to/node.exe",
    "args": ["C:/absolute/path/to/witness-server.mjs"],
    "allowedTools": ["read_reference"],
    "operationTimeoutMs": 10000,
    "maxInputBytes": 262144,
    "maxOutputBytes": 1048576,
    "maxStderrBytes": 65536
  }],
  "calls": [{
    "id": "reference-snapshot",
    "serverId": "project-reference",
    "tool": "read_reference",
    "arguments": {},
    "timeoutMs": 10000
  }]
}
```

The configuration seals the permitted tool names and calls before Cast. A new
server process is initialized and closed for each discovery or invocation.
Output is bounded and recorded as an observation. It cannot establish a
critical claim or dictate the verdict. The stdio subprocess is an
operator-selected program; stdio does not sandbox its access to the machine or
network. Choose its executable accordingly. Only explicitly listed
`passEnvironment` names are forwarded; secret-shaped call arguments are refused.
These witness capabilities declare unrestricted network access, so their Case
calls are refused under `local_only` privacy. A successful setup discovery does
not override that Case boundary.

The witness client refuses server requests for roots, sampling, and elicitation.
Connecting a witness therefore does not give it the user's conversation or turn
it into a model provider.

## Use a model supplied by the originating MCP client

MCP sampling is a separate compatibility path, `jevyr_run`, rather than an
advertised replacement for `submit` or a Connections model toggle. It requires
an initialized client that declares sampling support and keeps the originating
tool call open. Its client selects and reports the model. Judge cannot promise
that this is the model used in the client's surrounding conversation.

The Case must explicitly permit `provider_scoped` or `full_case` disclosure;
`local_only` is refused because a local MCP connection does not establish where
the client's model runs. Judge sends the bounded public prompt with
`includeContext: "none"` and no sampling tools. Sampling output passes the strict
contribution parser, token and response-byte limits. Client capability discovery
alone does not establish a successful inference or a qualified investigation.

The resulting Mind belongs only to that Case and open connection. It does not
replace the daemon's startup provider registry. The private duplex
`/v1/mcp/run` bridge accepts only loopback requests without an `Origin` header;
ordinary browser JavaScript cannot activate this path. Later frames can only
answer an outstanding sampling request, never change the sealed Case.

## Implementation references

- [Connection profiles and startup capture](../apps/daemon/src/connection-profiles.ts),
  [bounded metadata probes](../apps/daemon/src/connection-probes.ts),
  [local access checks](../apps/daemon/src/connection-access.ts), and
  [SDK connection contracts](../packages/sdk/src/connections.ts).
- [Judge MCP server and tool schemas](../apps/daemon/src/mcp.ts),
  [CLI stdio bridge](../apps/cli/src/main.ts), and
  [HTTP token reference](../apps/cli/src/airlock-commands.ts).
- [Witness configuration loader](../apps/daemon/src/mcp-witnesses.ts) and
  [bounded stdio witness client](../packages/runtime/src/mcp-client.ts).
- [Sampling Mind](../packages/runtime/src/adapters/mcp-sampling.ts),
  [private duplex server](../apps/daemon/src/mcp-client-run.ts), and
  [CLI sampling bridge](../apps/cli/src/mcp-client-run.ts).

Connection checks and profile saves grant no evaluator authority. Successful
model delivery still requires retained invocation receipts, physical evidence
where required, and independent replay of the signed Record.
