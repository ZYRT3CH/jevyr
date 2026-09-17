# Generic text/stdin Mind

`TextStdinMindAdapter` connects a startup-selected executable to the ordinary Mind interface. It writes the runtime's exact prepared public prompt to stdin, closes stdin, and admits one complete UTF-8 JSON document from stdout:

```json
{"contributions":[{"kind":"claim","summary":"A concise public assertion."}]}
```

Configure it before daemon startup:

```powershell
$env:JEVYR_STDIN_COMMAND = 'C:\Tools\my-model-wrapper.exe'
$env:JEVYR_STDIN_ARGS_JSON = '["--format","jevyr-json"]'
$env:JEVYR_STDIN_PROBE_ARGS_JSON = '["--version"]'
$env:JEVYR_STDIN_TIMEOUT_MS = '180000'
```

Arguments are a bounded JSON string array, passed as literal argv with `shell:false`. The default run arguments are empty. The probe defaults to `--version`; an explicit empty probe array runs the executable with closed, empty stdin. Environment options without a command, malformed JSON, NUL bytes, excessive arguments, unknown adapter options and caller-supplied `cwd` are refused. The command/argv/probe/limit configuration is digested into the capability version, so changing it changes the daemon's sealed policy identity. Configuration is captured once and is never supplied by a Case or later message.

The program receives a new empty temporary cwd for each invocation and probe. Normal workspace environment pointers and paths are scrubbed, and `JEVYR_*` configuration variables are withheld. Provider installation/authentication environment remains available through the existing process-provider boundary. The temporary directory is removed after process closure. The bridge never mounts or copies the host project, places subject locators on argv, or adds raw Case objects beside the prepared prompt.

This is the same quarantined context boundary as the existing process-backed Minds. An arbitrary executable still has the host user's OS permissions: it is **not a sandbox**. Its capability honestly declares `network:unrestricted` and `canExecuteTools:true`, so `local_only` Cases do not select it, and privacy projection remains the runtime's responsibility. Only install trusted wrappers. Process output remains untrusted cognition and never gains Forge evidence authority.

The default timeout is 180 seconds and may be configured up to 24 hours; a Case's invocation signal can impose a tighter deadline. Input and combined stdout/stderr are limited to 2,000,000 bytes. The invocation's remaining input/output token grants tighten those byte ceilings conservatively. Exhausted input/output permission is refused before launch, excess output kills the process, and abort/timeout/nonzero exit fails the invocation. The bridge meters every retained output byte from both pipes, including diagnostics; it does not accept provider-reported token usage.

Stdout must contain exactly one object with one `contributions` field. Extra prose, code fences, multiple documents, duplicate keys, malformed UTF-8, truncated output and usage/self-report fields are refused. Contributions use the existing strict structured parser. DIVERGE must return exactly one candidate with a complete finite `jevyr.candidate-blueprint/1` source; a promise or sketch without source cannot become an embodied candidate. Failure messages are sanitized and exclude command paths, raw stderr and rejected JSON. Only parsed public contributions cross into Blood.

Embedders can construct the adapter directly with `{command,args?,probeArgs?,timeoutMs?,maxInputBytes?,maxOutputBytes?}`. The configuration arrays and environment are snapshotted. There is no interactive transport, shell command interpolation, working-directory option, or continuation method.
