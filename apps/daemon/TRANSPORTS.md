# Cast transports

Every ingress calls the same `runtime.orchestrator.cast` exactly once with a complete `jevyr.case/1` submission. There is no continuation, approval, or verdict input. Transport framing, request IDs, filenames and A2A context IDs do not become Case identity. Identical complete submissions and captured material produce identical `submissionDigest`, `caseDigest` and material-capture digest; independent executions receive different run identities.

The Fastify 5 service owns routing and server lifetime. Admission runs in `onRequest` with `reply.hijack()` so Bone retains the raw bytes required for duplicate-key rejection, fatal UTF-8 decoding, bounded streaming and the originating MCP model duplex connection. HTTP body limits default to 1 MiB, with explicit time limits. Framework JSON replacement decoding cannot silently alter a Cast.

## HTTP and multipart

`POST /v1/cases` accepts `application/json` or `multipart/form-data`. Multipart requires one part named `case`, containing complete CaseSubmission JSON. A JSON file uploaded as that part works directly. Optional UTF-8 subject files use names `subject:<id>` and must correspond to a declared `text` subject whose locator is `upload:<id>`. Expansion happens before Cast, producing exactly the JSON submission with that text inline. Binary subject material continues to use file/artifact subject references; arbitrary archive unpacking is not an ingress capability.

```json
{"protocol":"jevyr.case/1","case":{"impulse":"Create and judge this design","seed":"trial-1","subjects":[{"id":"brief","kind":"text","locator":"upload:brief"}]}}
```

The `subject:brief` part supplies its exact UTF-8 text. Parts are limited to 65 and headers to 8 KiB each, within the whole request bound. Duplicate or undeclared parts, filename paths, replacement UTF-8, duplicate JSON fields, multipart preambles and epilogues are refused before Seal. No uploaded filename is written to the filesystem.

## JSONL daemon

Run `jevyr-daemon jsonl`. Stdin and stdout carry one JSON object per LF-delimited line; diagnostics use stderr. Every line requires `protocol`, bounded `id`, and `operation`.

```json
{"protocol":"jevyr.jsonl/1","id":1,"operation":"cast","submission":{"protocol":"jevyr.case/1","case":{"impulse":"Create and judge a counter","seed":"trial-1"}}}
```

The response is `{ "protocol": "jevyr.jsonl/1", "id": 1, "result": <SealReceipt> }`. Read operations are `status`, `record`, `terminal`, and `events`, with a canonical `caseId`. Events optionally accept integer `after` and `limit` (1–2000). An unavailable Record or terminal receipt returns `null`. Unknown fields are refused. The 1 MiB bound applies per line, before decoding; oversized frames are discarded through their LF, allowing the next independent request to proceed. Each response awaits output backpressure. At most 32 admitted Cases remain active before additional Cast input waits. EOF closes input and waits for all accepted Cases to reach terminal closure under their sealed runtime deadlines.

JSONL also exposes read-only `seal`, `seal-envelope`, `record-envelope`, `terminal-envelope`, and `artifacts` operations by Case ID, plus the global `trust` operation. The three envelope readers and public trust bundle let a consumer authenticate output without switching to HTTP.

## Atomic drop folders

Run `jevyr-daemon drop <directory>` to poll, or add `--once` to process the current ready set. Prepare a directory containing exactly one bounded, regular, singly-linked `case.json`. Atomically rename the prepared directory to a name matching `[A-Za-z0-9][A-Za-z0-9_-]{0,127}.ready` in the watched directory. Relative subject locators retain the normal daemon semantics; this transport does not rewrite subject paths.

The daemon atomically claims each ready directory under a server-generated UUID ending `.processing`. It captures stable bytes without following links, seals once, writes `seal.json`, waits for closure, then writes `record.json` and `terminal.json` before renaming to `.done`. It also exports `seal-envelope.json`, `record-envelope.json`, `terminal-envelope.json`, public `trust.json`, and the `artifacts.json` index so file consumers can authenticate the result. Admission failures become `.failed` with `error.json` when the claimed directory is safe to write. Invalid lifecycle results remain signed terminal output, not transport success claims. Ready sets are processed sequentially in bounded batches of 256.

Staging directories, `.done`, `.failed`, and stale `.processing` claims are never recast automatically. A crash after admission can leave a `.processing` bundle without a receipt; inspect the store rather than renaming it back to `.ready`. This intentionally provides at-most-once automatic admission, not an unsupported exactly-once claim across process crashes. The store has the existing exclusive daemon lease.

## A2A 1.0

`GET /.well-known/agent-card.json` advertises the [A2A 1.0 HTTP+JSON binding](https://a2a-protocol.org/latest/specification/). Send `A2A-Version: 1.0`. The input is one `ROLE_USER` message with a bounded `messageId` and exactly one part: either `data` containing the complete CaseSubmission or `text` containing the impulse. Unknown semantic metadata, multiple parts, task/context continuation, push notifications and cancellation are refused.

```json
{"message":{"messageId":"request-1","role":"ROLE_USER","parts":[{"data":{"protocol":"jevyr.case/1","case":{"impulse":"Create and judge a counter","seed":"trial-1"}}}]} ,"configuration":{"returnImmediately":true,"acceptedOutputModes":["application/json"],"historyLength":0}}
```

`POST /a2a/message:send` seals and, by default, waits for terminal completion. `returnImmediately:true` returns the task after Seal. `POST /a2a/message:stream` casts once and streams immutable ledger progress. `GET /a2a/tasks/<caseId>` reads current status. `POST /a2a/tasks/<caseId>:subscribe` accepts only `{}` and opens a read-only SSE stream for an active task, optionally resuming with `Last-Event-ID`. Terminal subscription is refused; read the task instead. Task and final stream metadata include the canonical Seal, terminal receipt and DSSE envelopes. Task completion maps lifecycle closure, and does not imply an ACCEPT judgment. Message IDs are correlation identifiers, not durable idempotency keys; retransmission creates another independent Case.

## Outbound peers

Set `JEVYR_PEERS_FILE` before daemon startup to bind up to eight peers:

```json
{"protocol":"jevyr.peers/1","peers":[{"id":"mind.peer.local","endpoint":"http://127.0.0.1:4400/a2a","timeoutMs":60000,"credentialReference":"PEER_LOCAL_TOKEN"}]}
```

`credentialReference` names an environment secret captured by the audience-bound broker; secret values never enter the public descriptor, prompts or Case. Remote endpoints require both HTTPS and `allowRemote:true`. Redirects, URL credentials, query strings and fragments are refused. Each invocation sends only the runtime's prepared privacy projection, requests one final A2A task/message, bounds response bytes and time, and accounts for complete returned bytes conservatively. Peer outputs are quarantined; claimed evidence references are stripped. A peer Record is a witness claim until this runtime establishes its own evidence. Peers cannot introduce providers or capabilities after Seal.

Jevyr-originated dispatch carries `x-jevyr-peer-dispatch: one-shot`. An inbound delegated Case requires a leaf runtime with no outbound A2A minds, preventing accidental self-delegation or recursive civilizations from opening unlimited fresh Case budgets. Independent leaf peers may still provide heterogeneous observations.

## Read-only Genome Lab and Juggler vouchers

`GET /v1/genome-lab` returns the startup-bound active Genome, immutable selection provenance, governance requirements, and up to 256 validated offspring proposals with benchmark/damage evidence. It never changes the active pointer. The TypeScript client exposes `genomeLab()`.

For a Case sealed with `control:"juggler"`, `GET /v1/cases/<caseId>/vouchers` exposes currently offered server-generated resource tokens. `POST /v1/cases/<caseId>/vouchers/redeem` accepts exactly `{ "voucher": "<43-character opaque token>" }`, once, before its scheduling checkpoint. The server alone determines Mass, Refraction, Polarity, Fission and Inertia effects within the sealed resource envelope. Tokens cannot carry prose, names, resource numbers, approvals, evidence or verdicts. The receipt binds before/after scheduling and states `verdictAuthority:"none"`. Sovereign Cases and late/spent tokens are refused.
