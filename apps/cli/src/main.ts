#!/usr/bin/env node
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createJevyrHttpService, serveMcpBackend } from "@jevyr/daemon";
import { parseJsonBytes } from "@jevyr/core";
import {
  JevyrClient,
  type JevyrReadiness,
  type JevyrRecord,
  type PublicTraceEvent,
  type ReadinessBlockerCode,
} from "@jevyr/sdk";
import {
  caseMode,
  control,
  flag,
  assertCommandInvocation,
  option,
  parseArguments,
  parseSubject,
  privacy,
} from "./arguments.js";
import { loadCorpus, runCorpus, validateCorpus } from "./benchmark.js";
import { verifyProofBundle } from "./bundle.js";
import { initialize, invocationBase, loadConfig } from "./config.js";
import { renderFrame, renderRecord, renderSealReceipt, shortError } from "./display.js";
import { createMcpClientRunBridge } from "./mcp-client-run.js";
import { createReleaseReport } from "./release-report.js";
import { runGovernanceCommand } from "./governance-commands.js";
import { httpClientHeaders, runAirlockCommand } from "./airlock-commands.js";
import { airlockLaunchUrl } from "./airlock-launch.js";
import { chamberLaunchPlan, chamberLoopbackEndpoint as loopbackEndpoint } from "./chamber-launch.js";
import {
  compareRecords,
  readIntentContract,
  readRecord,
  readUnsignedDiagnosticRecord,
  replayAuthenticatedCase,
  replayTrace,
} from "./replay.js";

const exec = promisify(execFile);
const MAX_CAST_INPUT_BYTES = 1_048_576;

const HELP = `Jevyr — cast once, observe live, receive a signed Record
The canonical command is jevyr. judge remains as a legacy alias.

Usage:
  jevyr init [directory] [--force]
  jevyr up [--local-model MODEL] [--no-open]
  jevyr doctor [--json]
  jevyr juggler CASE_ID [--redeem Mass|Refraction|Polarity|Fission|Inertia --quantity N] [--json]
  jevyr cast "one or a few sentences" [--subject kind:locator] [--mode auto] [--constraint TEXT] [--requested-assay TEXT] [--privacy local_only] [--control sovereign] [--seed TEXT]
  jevyr watch CASE_ID [--cursor N] [--json | --tui]
  jevyr open CASE_ID [--chamber-url URL]
  jevyr replay CASE_ID [--json]
  judge replay CASE_ID --same-seed|--new-seed [--json]
  jevyr replay record.json --events events.json --intent-contract intent-contract.json --unsigned-diagnostic [--json]
  jevyr compare CASE_ID|record.json CASE_ID|record.json [--json]
  jevyr benchmark [--corpus benchmarks/corpus.v1.json] [--validate-only] [--report FILE] [--json]
  jevyr benchmark build|run|compare --file FILE [--report FILE] [--signing-key-ref env:VARIABLE]
  jevyr preset save --file SIGNED_BENCHMARK --name NAME --configuration DIGEST --signing-key-ref env:VARIABLE
  jevyr preset use DIGEST | off | wild
  jevyr genome inspect | propose --file FILE | promote DIGEST --attestation FILE
  judge airlock [path] [--no-open]
  jevyr airlock create --file FILE | show DRAFT_ID | edit DRAFT_ID --revision N --file FILE
  jevyr airlock seal DRAFT_ID --revision N --policy-digest DIGEST
  judge run --case FILE
  jevyr abort CASE_ID
  jevyr verify-bundle DIRECTORY [--trusted-key-id sha256:...] [--expected-runtime-sha SHA] [--expected-subject-sha SHA] [--expected-workflow-sha SHA] [--json]
  jevyr mcp serve [--url URL]

  'jevyr up' starts the loopback daemon and built production Chamber, prints both addresses,
  and opens the Chamber unless --no-open is supplied. --local-model explicitly
  configures one Ollama model only when this command starts a new daemon.
  Init preserves existing files; --force replaces the five portable defaults.
  New policies select Bone v2. Init installs no calibration or private state.
  Onboarding: docs/new-projects.md
  MCP client command: jevyr
  MCP client arguments: mcp, serve
  MCP bridges to the running daemon and never opens a second repository runtime.
  MCP exposes submit, status, result and bounded evaluate. No post-seal message
  tool is advertised. Legacy sampling bridges require an originating client's
  declared capability and explicit provider_scoped or full_case privacy.

  Watch authenticates the Seal, complete public hash chain, signed Record, terminal closure,
  and exact artifact inventory; it does not replay persisted evidence.
  Use replay for an independent persisted-evidence validity result.

  Live Juggler offers calibrated additive work within the presealed allowance.
  Redemption sends one offered ballId and bounded quantity, with no verdict authority.

  There is deliberately no continue or send-message command after the airlock seals.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("Piped Cast input must arrive as undecoded bytes");
    }
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_CAST_INPUT_BYTES) {
      throw new RangeError(`Piped Cast input exceeds ${MAX_CAST_INPUT_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  return decodeCastInput(Buffer.concat(chunks, size), "Piped Cast input");
}

function decodeCastInput(bytes: Uint8Array, label: string): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new TypeError(`${label} is not valid UTF-8`, { cause });
  }
  return value.trim();
}

async function readCastFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_CAST_INPUT_BYTES) {
    throw new RangeError(`Cast input file exceeds ${MAX_CAST_INPUT_BYTES} bytes`);
  }
  return decodeCastInput(bytes, "Cast input file");
}

async function commandAvailability(
  command: string,
  args: string[] = ["--version"],
): Promise<{ available: boolean; status: "available" | "unavailable" }> {
  try {
    await exec(command, args, { timeout: 4_000, windowsHide: true });
    return { available: true, status: "available" };
  } catch {
    return { available: false, status: "unavailable" };
  }
}

const DOCTOR_GUIDANCE: Readonly<Record<ReadinessBlockerCode, string>> = Object.freeze({
  "models.template-only": "Explicitly enable a reasoning adapter before launch, for example `judge up --local-model qwen3-coder:30b-32k` for an installed local model. Native Codex and Claude setup and broker references are documented in docs/agent-providers.md.",
  "models.reasoning-unavailable": "Start or authenticate the configured reasoning provider, then let the next readiness probe run.",
  "forge.observe-only": "Use the policy-default Docker Forge for adjudicative experiments; observation-only mode cannot execute.",
  "forge.diagnostic-only": "Restart with the built-in Docker Forge; trusted-host results remain diagnostic by design.",
  "forge.opaque": "Restart with the built-in Docker Forge so Bone can verify the execution substrate.",
  "forge.substrate-unavailable": "Start the configured Docker or Podman engine, ensure the policy image exists locally, and restart Jevyr so its immutable image ID can be sealed.",
  "forge.execution-disabled": "Restart with a Forge capability that can execute the startup-sealed Docker image.",
  "forge.probe-unavailable": "Restore the startup-sealed Docker image or engine, then re-run doctor; a different image requires daemon restart.",
  "assays.empty": "Add a finite assay to .jevyr/assay-frontier.json and restart. A fresh `jevyr init` installs the comparative node experiment entrypoint.",
});

function doctorText(
  readiness: JevyrReadiness | undefined,
  commands: Readonly<Record<string, { readonly available: boolean; readonly status: "available" | "unavailable" }>>,
): string {
  if (readiness === undefined) {
    return [
      "UNAVAILABLE daemon readiness could not be read or validated.",
      "Start it with `jevyr up`, then run `jevyr doctor` again.",
      "",
      "Local command discovery (installed does not mean configured):",
      ...Object.entries(commands).map(([name, value]) => `${value.available ? "OK" : "--"} ${name.padEnd(8)} ${value.status}`),
    ].join("\n");
  }
  const lines = [
    `${readiness.ready ? "READY" : "BLOCKED"} Jevyr ${readiness.ready ? "has" : "does not yet have"} complete execution infrastructure.`,
    `models  ${readiness.models.mode}; configured=${readiness.models.configuredCount}, reasoning-available=${readiness.models.reasoningAvailableCount}`,
    `forge   ${readiness.forge.status}; authority=${readiness.forge.evidenceAuthority}`,
    `assays  ${readiness.assays.count} ${readiness.assays.status}; mode=${readiness.assays.mode}; applicability=${readiness.assays.caseApplicability}`,
  ];
  if (readiness.blockers.length > 0) {
    lines.push("", "Required configuration:");
    for (const blocker of readiness.blockers) {
      lines.push(`- ${blocker.detail}`, `  ${DOCTOR_GUIDANCE[blocker.code]}`);
    }
  }
  lines.push(
    "",
    "Local command discovery (installed does not mean configured):",
    ...Object.entries(commands).map(([name, value]) => `${value.available ? "OK" : "--"} ${name.padEnd(8)} ${value.status}`),
  );
  return lines.join("\n");
}

async function openUrl(url: string): Promise<void> {
  const environment: NodeJS.ProcessEnv = {};
  const essentials = new Set(["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TZ", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (essentials.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  }
  // A Windows -Command tail is executable source, even when passed as an
  // argv array. Keep the entire URL in data so query punctuation stays literal.
  if (process.platform === "win32") environment.JEVYR_BROWSER_OPEN_URL = url;
  const command =
    process.platform === "win32"
      ? {
          file: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:JEVYR_BROWSER_OPEN_URL -ErrorAction Stop"],
        }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: environment,
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); rejectOpen(new Error("The browser opener did not complete within 10 seconds")); }, 10_000);
    const finish = (error?: Error) => { clearTimeout(timer); if (error) rejectOpen(error); else resolveOpen(); };
    child.once("error", finish);
    if (process.platform === "win32") child.once("exit", code => finish(code === 0 ? undefined : new Error(`The browser opener exited with code ${code ?? "none"}`)));
    else child.once("spawn", () => finish());
  });
  child.unref();
}

async function httpAvailable(origin: string, path = "/"): Promise<boolean> {
  try {
    const response = await fetch(new URL(path, `${origin}/`), { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

async function jevyrDaemonReadiness(origin: string): Promise<JevyrReadiness | undefined> {
  try {
    return await new JevyrClient({ baseUrl: origin, headers: httpClientHeaders() }).readiness(AbortSignal.timeout(10_000));
  } catch {
    return undefined;
  }
}

function explicitLocalModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
    throw new TypeError("--local-model must be a bounded Ollama model name using letters, digits, '.', '_', ':', '/', or '-'");
  }
  return value;
}

async function waitForHttp(origin: string, child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The Chamber process exited before ${origin} became ready`);
    if (await httpAvailable(origin)) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`The Chamber did not become ready at ${origin} within ${timeoutMs} ms`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, 3_000);
    timer.unref();
  });
  await Promise.race([closed, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function runUp(
  base: string,
  daemonValue: string,
  chamberValue: string,
  options: { readonly open: boolean; readonly json: boolean; readonly localModel?: string; readonly openTarget?: string; readonly onReady?: () => void },
): Promise<number> {
  if (options.localModel !== undefined && existsSync(join(base, ".jevyr", "connections.json"))) {
    throw new Error("A saved Connections profile controls the startup model selection. Edit it in the Connections page, or remove the saved profile before using --local-model.");
  }
  const daemon = loopbackEndpoint(daemonValue, "daemonUrl");
  const chamber = loopbackEndpoint(chamberValue, "chamberUrl");
  let daemonService: ReturnType<typeof createJevyrHttpService> | undefined;
  let chamberProcess: ChildProcess | undefined;
  try {
    // Validate the installed presentation build before starting a new daemon.
    const launch = await httpAvailable(chamber.origin) ? undefined : await chamberLaunchPlan(daemon.origin, chamber.origin);
    const runningReadiness = await jevyrDaemonReadiness(daemon.origin);
    if (runningReadiness !== undefined && options.localModel !== undefined) {
      const expectedAdapterId = `mind.ollama.${options.localModel}`;
      if (!runningReadiness.models.adapters.some((adapter) => adapter.id === expectedAdapterId)) {
        throw new Error(
          `The daemon is already running with immutable startup model configuration and does not include ${expectedAdapterId}; stop it, then rerun jevyr up --local-model ${options.localModel}`,
        );
      }
    }
    if (runningReadiness === undefined) {
      const daemonEnvironment = {
        ...process.env,
        ...(options.localModel === undefined ? {} : { JEVYR_OLLAMA_MODEL: options.localModel }),
      };
      daemonService = createJevyrHttpService({
        projectRoot: base,
        allowedOrigins: [chamber.origin],
        env: daemonEnvironment,
      });
      await daemonService.listen(daemon.port, daemon.host);
    }

    if (launch) {
      chamberProcess = spawn(
        launch.executable,
        launch.args,
        {
          cwd: launch.cwd,
          // Provider credentials belong to the daemon. The presentation
          // process receives only its public loopback API origin.
          env: launch.env,
          stdio: [...launch.stdio],
          windowsHide: launch.windowsHide,
        },
      );
      const launchFailure = new Promise<never>((_resolve, reject) => {
        chamberProcess!.once("error", reject);
      });
      await Promise.race([waitForHttp(chamber.origin, chamberProcess), launchFailure]);
    }

    process.stdout.write(options.json
      ? `${JSON.stringify({ protocol: "jevyr.up/1", daemon: daemon.origin, chamber: chamber.origin, opened: options.open })}\n`
      : `Jevyr daemon   ${daemon.origin}\nJevyr Chamber  ${chamber.origin}\n`);
    if (options.open) await openUrl(options.openTarget ?? chamber.origin);
    options.onReady?.();
    if (daemonService === undefined && chamberProcess === undefined) return 0;
    if (chamberProcess && chamberProcess.exitCode !== null) throw new Error(`The Chamber process exited unexpectedly (${chamberProcess.exitCode})`);

    await new Promise<void>((resolveStop, rejectStop) => {
      const stop = (): void => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolveStop();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      chamberProcess?.once("exit", (code) => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        rejectStop(new Error(`The Chamber process exited unexpectedly (${code ?? "no exit code"})`));
      });
    });
    return 0;
  } finally {
    await stopChild(chamberProcess);
    await daemonService?.close();
  }
}

function isLocalReference(reference: string): boolean {
  return (
    reference.endsWith(".json") ||
    reference.includes("/") ||
    reference.includes("\\") ||
    reference.startsWith(".")
  );
}

async function recordFrom(
  reference: string,
  client: JevyrClient,
  base: string,
): Promise<JevyrRecord> {
  return isLocalReference(reference)
    ? await readRecord(resolve(base, reference))
    : (await client.authenticatedRecord(reference)).payload;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let command: string[] | undefined;
    try {
      process.stdout.write(`\nJEVYR\nCast once. Watch what unfolds.\n\nProject: ${invocationBase()}\n\n  1  Start / open the app\n  2  Check models and runtime readiness\n  3  Submit a new case\n  4  Watch a case live\n  5  Command reference\n  q  Exit\n\n`);
      const choice = (await terminal.question("Choose: ")).trim().toLowerCase();
      if (choice === "1") command = ["up"];
      else if (choice === "2") command = ["doctor"];
      else if (choice === "3") {
        const impulse = (await terminal.question("Your one-time input: ")).trim();
        if (impulse) {
          process.stdout.write("Uses the running daemon's configured model and this project's privacy policy. Submission seals the case.\n");
          if ((await terminal.question("Seal and submit? [y/N] ")).trim().toLowerCase() === "y") command = ["cast", impulse];
        }
      } else if (choice === "4") {
        const id = (await terminal.question("Case ID: ")).trim();
        if (id) command = ["watch", id, "--tui"];
      } else if (choice === "5") command = ["help"];
      else if (choice !== "q" && choice !== "") process.stdout.write("Unknown choice. Run jevyr to try again.\n");
    } finally {
      terminal.close();
    }
    return command ? await main(command) : 0;
  }
  const args = parseArguments(argv);
  const json = flag(args, "json");

  if (
    args.command === "help" ||
    args.command === "--help" ||
    args.command === "-h" ||
    flag(args, "help")
  ) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  assertCommandInvocation(args);
  const base = invocationBase();
  if (["genome", "preset"].includes(args.command) || args.command === "benchmark" && args.positionals.length > 0) return runGovernanceCommand(args, base);
  if (args.command === "init") {
    const result = await initialize(resolve(base, args.positionals[0] ?? "."), {
      force: flag(args, "force"),
    });
    process.stdout.write(
      json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${
            [
              ...result.created.map((path) => `created ${path}`),
              ...result.replaced.map((path) => `replaced ${path}`),
            ].join("\n") || "Jevyr files already exist; nothing was overwritten."
          }\n`,
    );
    return 0;
  }
  if (args.command === "verify-bundle") {
    const directory = args.positionals[0];
    if (!directory) throw new TypeError("verify-bundle requires DIRECTORY");
    const report = await verifyProofBundle(resolve(base, directory), {
      ...(option(args, "trusted-key-id") === undefined ? {} : { trustedKeyId: option(args, "trusted-key-id")! }),
      ...(option(args, "expected-runtime-sha") === undefined ? {} : { expectedRuntimeSha: option(args, "expected-runtime-sha")! }),
      ...(option(args, "expected-subject-sha") === undefined ? {} : { expectedSubjectSha: option(args, "expected-subject-sha")! }),
      ...(option(args, "expected-workflow-sha") === undefined ? {} : { expectedWorkflowSha: option(args, "expected-workflow-sha")! }),
    });
    process.stdout.write(json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${report.valid ? "VALID" : report.integrityValid ? "UNANCHORED" : "INVALID"} proof bundle${report.caseId ? ` ${report.caseId}` : ""}\ntrust=${report.trust.scope}${report.trust.keyId ? ` key=${report.trust.keyId}` : ""}${report.problems.length === 0 ? "" : `\nproblems\n${report.problems.map((problem) => `- ${problem}`).join("\n")}`}\n`);
    return report.valid ? 0 : 7;
  }
  const config = await loadConfig(base);
  const daemonUrl = option(args, "url") ?? config.daemonUrl;
  if (args.command === "airlock" && !option(args, "file") && (args.positionals.length === 0 || args.positionals.length === 1 && !["create", "show", "edit", "seal"].includes(args.positionals[0]!))) {
    const chamber = option(args, "chamber-url") ?? config.chamberUrl;
    const url = await airlockLaunchUrl(base, args.positionals[0], chamber, daemonUrl);
    const announce = () => { process.stdout.write(json ? `${JSON.stringify({ protocol: "jevyr.airlock-launch/1", url, sealed: false })}\n` : `${url}\nEditable Airlock only; inspect the draft before sealing.\n`); };
    if (!flag(args, "no-open")) return await runUp(base, daemonUrl, chamber, { open: true, openTarget: url, onReady: announce, json });
    announce();
    return 0;
  }
  const client = new JevyrClient({ baseUrl: daemonUrl, headers: httpClientHeaders() });
  if (["airlock", "run", "abort"].includes(args.command)) return runAirlockCommand(args, base, client);
  if (args.command === "up") {
    const localModel = explicitLocalModel(option(args, "local-model"));
    return await runUp(
      base,
      daemonUrl,
      option(args, "chamber-url") ?? config.chamberUrl,
      {
        open: !flag(args, "no-open"),
        json,
        ...(localModel === undefined ? {} : { localModel }),
      },
    );
  }
  if (args.command === "doctor") {
    const [readiness, git, docker, podman, codex, claude, ollama, lms] = await Promise.all([
      client.readiness().catch(() => undefined),
      commandAvailability("git"),
      commandAvailability("docker"),
      commandAvailability("podman"),
      commandAvailability("codex"),
      commandAvailability("claude"),
      commandAvailability("ollama"),
      commandAvailability("lms"),
    ]);
    const commands = { git, docker, podman, codex, claude, ollama, lms };
    const report = {
      protocol: "jevyr.doctor/2",
      ready: readiness?.ready ?? false,
      daemon: readiness === undefined
        ? { status: "unavailable" as const, readiness: null }
        : { status: readiness.ready ? "ready" as const : "blocked" as const, readiness },
      commands,
    };
    process.stdout.write(
      json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${doctorText(readiness, commands)}\n`,
    );
    return readiness === undefined ? 2 : readiness.ready ? 0 : 3;
  }
  if (args.command === "juggler") {
    const caseId = args.positionals[0]!;
    const offers = await client.metabolismOffers(caseId);
    const kind = option(args, "redeem");
    if (kind === undefined) {
      process.stdout.write(json ? `${JSON.stringify(offers, null, 2)}\n`
        : `${offers.offers.length ? `Available additions: ${offers.offers.map(offer => `${offer.kind} (1–${offer.maxQuantity})`).join(", ")}` : "No calibrated addition is currently offered."}\nCase ${offers.caseId}; run ${offers.runDigest}\nAdmission ${offers.admission}; ${offers.receipts.length} independently signed receipts. Verdict authority: none.\n`);
      return 0;
    }
    const offer = offers.offers.find(offer => offer.kind === kind);
    if (!offer) throw new TypeError(`${kind} is not currently offered for this Case; it may be spent, unavailable within its resource ceiling, or past its checkpoint`);
    const redemption = await client.redeemMetabolism(caseId, offer.ballId, Number(option(args, "quantity") ?? 1));
    const receipt = redemption.receipt;
    process.stdout.write(json ? `${JSON.stringify(redemption, null, 2)}\n`
      : `${receipt.kind} × ${receipt.quantity} redeemed; signed receipt ${receipt.digest}\n${JSON.stringify(receipt.grant)}\nVerdict authority: ${receipt.verdictAuthority}; baseline unchanged.\n`);
    return 0;
  }
  if (args.command === "cast") {
    let impulse = args.positionals.join(" ").trim();
    const file = option(args, "file");
    if (file && impulse) throw new TypeError("Use a positional impulse or --file, not both");
    if (file) impulse = await readCastFile(resolve(base, file));
    if (!impulse && !process.stdin.isTTY) impulse = await readStdin();
    if (!impulse)
      throw new TypeError("Cast requires one or a few sentences, --file, or piped UTF-8 input");
    const subjects = (args.options.get("subject") ?? []).map((subject, index) =>
      parseSubject(subject, `subject-${index + 1}`),
    );
    const constraints = args.options.get("constraint") ?? [];
    const requestedAssays = args.options.get("requested-assay") ?? [];
    const mode = caseMode(option(args, "mode"));
    const accepted = await client.cast({
      protocol: "jevyr.case/1",
      case: {
        impulse,
        subjects,
        ...(mode === undefined ? {} : { mode }),
        ...(constraints.length === 0 ? {} : { constraints }),
        ...(requestedAssays.length === 0 ? {} : { requestedAssays }),
        privacy: privacy(option(args, "privacy"), config.privacy),
        control: control(option(args, "control"), config.control),
        ...(option(args, "seed") === undefined ? {} : { seed: option(args, "seed")! }),
      },
    });
    process.stdout.write(
      json ? `${JSON.stringify(accepted, null, 2)}\n` : `${renderSealReceipt(accepted)}\n`,
    );
    return 0;
  }
  if (args.command === "watch") {
    const caseId = args.positionals[0];
    if (!caseId) throw new TypeError("watch requires CASE_ID");
    const cursor = Number(option(args, "cursor") ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new TypeError("--cursor must be a non-negative integer");
    const pollWaitMs = Number(option(args, "wait-ms") ?? 15_000);
    const observer = new AbortController();
    const tui = flag(args, "tui")
      ? (await import("./tui.js")).createWatchTui(caseId, () => observer.abort(), client, { cursor })
      : undefined;
    const stopObserver = () => { tui?.close(); observer.abort(); };
    if (tui) { process.once("SIGINT", stopObserver); process.once("SIGTERM", stopObserver); }
    let authenticatedCursor = cursor;
    let authenticatedCursorDigest: string | undefined;
    try {
    await tui?.ready;
    for await (const frame of client.liveEvents(caseId, {
      cursor,
      pollWaitMs,
      ...(tui ? { signal: observer.signal } : {}),
    })) {
      authenticatedCursor = frame.event.sequence;
      authenticatedCursorDigest = frame.headDigest;
      if (tui) tui.push(frame);
      else process.stdout.write(json ? `${JSON.stringify(frame)}\n` : `${renderFrame(frame)}\n`);
    }
    } catch (error) {
      if (!observer.signal.aborted) throw error;
    } finally {
      tui?.close();
      if (tui) { process.removeListener("SIGINT", stopObserver); process.removeListener("SIGTERM", stopObserver); }
    }
    if (observer.signal.aborted) {
      process.stdout.write(`Observer closed. Case ${caseId} continues independently.\n`);
      return 0;
    }
    // Do not treat a valid Record signature as proof that the observer saw the
    // complete ending. Resume at the last displayed frame, then authenticate
    // the independently signed terminal status, ledger head, Record digest,
    // and exact artifact inventory under the same repository key.
    const authenticated = await client.waitForAuthenticatedRecord(caseId, {
      cursor: authenticatedCursor,
      ...(authenticatedCursorDigest === undefined ? {} : { cursorDigest: authenticatedCursorDigest }),
      pollWaitMs,
    });
    const record = authenticated.payload;
    process.stdout.write(
      json
        ? `${JSON.stringify({
            type: "record",
            verification: authenticated.verification,
            verificationScope: authenticated.verificationScope,
            persistedEvidence: authenticated.persistedEvidence,
            keyId: authenticated.keyId,
            traceVerification: authenticated.traceVerification,
            terminal: {
              verification: authenticated.terminal.verification,
              keyId: authenticated.terminal.keyId,
              receipt: authenticated.terminal.payload,
            },
            record,
          })}\n`
        : `${renderRecord(record)}\nauthentication=${authenticated.verification} scope=${authenticated.verificationScope} key=${authenticated.keyId}\ntrace=${authenticated.traceVerification} terminal-key=${authenticated.terminal.keyId} artifact-index=${authenticated.terminal.payload.artifactIndexDigest}\npersisted-evidence=${authenticated.persistedEvidence}; run jevyr replay ${caseId} for independent validity\n`,
    );
    // `watch` succeeds when observation and authentication succeed. The signed
    // verdict is data, not this command's independent evidence-validity result.
    return 0;
  }
  if (args.command === "open") {
    const caseId = args.positionals[0];
    if (!caseId) throw new TypeError("open requires CASE_ID");
    const chamber = option(args, "chamber-url") ?? config.chamberUrl;
    const url = new URL(chamber);
    url.searchParams.set("case", caseId);
    await openUrl(url.toString());
    process.stdout.write(`${url}\n`);
    return 0;
  }
  if (args.command === "replay") {
    const reference = args.positionals[0];
    if (!reference) throw new TypeError("replay requires CASE_ID or a Record path");
    const local = isLocalReference(reference);
    const eventsPath = option(args, "events");
    const intentContractPath = option(args, "intent-contract");
    if (!local) {
      if (eventsPath || intentContractPath || flag(args, "unsigned-diagnostic")) {
        throw new TypeError(
          "Remote replay obtains its complete authenticated ledger and contract from the Case; local diagnostic options are not accepted",
        );
      }
      const verified = await client.waitForAuthenticatedRecord(reference);
      const replay = await replayAuthenticatedCase(client, reference, verified.payload);
      if (flag(args, "same-seed") || flag(args, "new-seed")) {
        if (!replay.valid) throw new Error("Cannot rerun a source whose signed evidence does not replay");
        const receipt = await client.reproduceCase(reference, flag(args, "same-seed") ? "same" : "new");
        const result = await client.waitForAuthenticatedRecord(receipt.caseId);
        process.stdout.write(`${JSON.stringify({ sourceCaseId: reference, seed: flag(args, "same-seed") ? "same" : "new", receipt, result }, null, json ? undefined : 2)}\n`);
        return 0;
      }
      const authenticity = { verification: verified.verification, keyId: verified.keyId };
      process.stdout.write(
        json
          ? `${JSON.stringify({ ...replay, authenticity }, null, 2)}\n`
          : `${replay.valid ? "VALID" : "INVALID"} ${replay.events} events\nexpected ${replay.expected}\nobserved ${replay.observed}\nauthenticity ${authenticity.verification} key=${authenticity.keyId}${replay.problems.length === 0 ? "" : `\nproblems\n${replay.problems.map((problem) => `- ${problem}`).join("\n")}`}\n`,
      );
      return replay.valid ? 0 : 4;
    }
    if (!eventsPath) throw new TypeError("Local Record replay requires --events events.json");
    if (!intentContractPath) {
      throw new TypeError("Local Record replay requires --intent-contract intent-contract.json");
    }
    const parsedEvents = parseJsonBytes(
      await readFile(resolve(base, eventsPath)),
      "Local event trace",
    );
    if (!Array.isArray(parsedEvents) || parsedEvents.length === 0) {
      throw new TypeError("Local event trace must be a non-empty JSON array");
    }
    const events = parsedEvents as PublicTraceEvent[];
    const record = await readUnsignedDiagnosticRecord(
      resolve(base, reference),
      flag(args, "unsigned-diagnostic"),
    );
    const intentContract = await readIntentContract(resolve(base, intentContractPath));
    const replay = await replayTrace(record, events, intentContract);
    const authenticity = { verification: "not-performed-unsigned-diagnostic" as const };
    process.stdout.write(
      json
        ? `${JSON.stringify({ ...replay, authenticity }, null, 2)}\n`
        : `${replay.valid ? "VALID" : "INVALID"} ${replay.events} events\nexpected ${replay.expected}\nobserved ${replay.observed}\nauthenticity ${authenticity.verification}${"keyId" in authenticity ? ` key=${authenticity.keyId}` : ""}${replay.problems.length === 0 ? "" : `\nproblems\n${replay.problems.map((problem) => `- ${problem}`).join("\n")}`}\n`,
    );
    return replay.valid ? 0 : 4;
  }
  if (args.command === "compare") {
    const [leftRef, rightRef] = args.positionals;
    if (!leftRef || !rightRef)
      throw new TypeError("compare requires two CASE_ID or Record references");
    const [left, right] = await Promise.all([
      recordFrom(leftRef, client, base),
      recordFrom(rightRef, client, base),
    ]);
    const differences = compareRecords(left, right);
    process.stdout.write(
      json
        ? `${JSON.stringify({ equivalent: differences.length === 0, differences }, null, 2)}\n`
        : differences.length === 0
          ? "Records are equivalent on compared fields.\n"
          : `${differences.map((difference) => `${difference.field}: ${String(difference.left)} -> ${String(difference.right)}`).join("\n")}\n`,
    );
    return differences.length === 0 ? 0 : 5;
  }
  if (args.command === "benchmark") {
    const corpusPath = resolve(base, option(args, "corpus") ?? "benchmarks/corpus.v1.json");
    const corpus = await loadCorpus(corpusPath);
    validateCorpus(corpus);
    if (flag(args, "validate-only")) {
      process.stdout.write(
        json
          ? `${JSON.stringify({ valid: true, cases: corpus.cases.length, invariants: corpus.requiredInvariants }, null, 2)}\n`
          : `VALID ${corpus.cases.length} cases, ${corpus.requiredInvariants.length} declared invariants\n`,
      );
      return 0;
    }
    const results = await runCorpus(corpus, client);
    const reportPath = option(args, "report");
    if (reportPath) {
      const target = resolve(base, reportPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(createReleaseReport(corpus, results), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    const passed = results.filter((result) => result.passed).length;
    process.stdout.write(
      json
        ? `${JSON.stringify({ passed, total: results.length, results }, null, 2)}\n`
        : `${results.map((result) => `${result.passed ? "PASS" : "FAIL"} ${result.id}${result.failures.length ? ` — ${result.failures.join("; ")}` : ""}`).join("\n")}\n${passed}/${results.length} passed\n`,
    );
    return passed === results.length ? 0 : 6;
  }
  if (args.command === "mcp" && args.positionals[0] === "serve") {
    const runWithClientModel = createMcpClientRunBridge(client.baseUrl, httpClientHeaders());
    await serveMcpBackend(
      {
        ready: async () => { await client.readiness(); },
        cast: async (caseIntent) => await client.cast({ protocol: "jevyr.case/1", case: caseIntent }),
        runWithClientModel,
        status: async (caseId) => await client.status(caseId),
        record: async (caseId) => await client.record(caseId),
        terminalResult: async (caseId) => {
          const status = await client.status(caseId);
          if (!["terminated", "invalid"].includes(status.lifecycle)) return undefined;
          const authenticated = await client.waitForAuthenticatedRecord(caseId, { preferSse: false });
          const [seal, sealEnvelope, recordEnvelope, terminal, terminalEnvelope, trust] = await Promise.all([
            client.sealReceipt(caseId), client.sealEnvelope(caseId), client.recordEnvelope(caseId), client.terminalReceipt(caseId), client.terminalEnvelope(caseId), client.trustBundle(),
          ]);
          return { protocol: "jevyr.mcp-result/1", seal, sealEnvelope, record: authenticated.payload, recordEnvelope, terminal, terminalEnvelope, trust };
        },
      },
      {
        input: process.stdin,
        send: (message) => { process.stdout.write(`${message}\n`); },
      },
    );
    return 0;
  }
  throw new TypeError(`Unknown command: ${args.command}\n\n${HELP}`);
}

const invoked = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (invoked) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`jevyr: ${shortError(error)}\n`);
      process.exitCode = 1;
    });
}
